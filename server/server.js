// SENTINEL — History Sync Server
// Node.js + Express + @libsql/client (Turso cloud SQLite — persists across restarts)

const express    = require('express');
const { createClient } = require('@libsql/client');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Auth token ───────────────────────────────────────────────────────────────
const TOKEN = process.env.SENTINEL_TOKEN;
if (!TOKEN) {
  console.error('ERROR: SENTINEL_TOKEN environment variable is not set.');
  process.exit(1);
}

// ── Turso client ─────────────────────────────────────────────────────────────
const TURSO_URL   = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;
if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('ERROR: TURSO_URL and TURSO_TOKEN environment variables must be set.');
  process.exit(1);
}

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

async function initDB() {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS da_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker     TEXT NOT NULL,
      analysis   TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_da_ticker ON da_history(ticker)`,
    `CREATE TABLE IF NOT EXISTS ps_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  ], 'write');
  console.log('Turso database ready:', TURSO_URL);
}

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Sentinel-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function auth(req, res, next) {
  const token = req.headers['x-sentinel-token'];
  if (!token || token !== TOKEN) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  next();
}

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Deep Analysis ─────────────────────────────────────────────────────────────
app.get('/api/da', auth, async (req, res) => {
  try {
    const { rows } = await db.execute('SELECT ticker, analysis FROM da_history ORDER BY id ASC');
    const result = {};
    rows.forEach(row => {
      const parsed = JSON.parse(row.analysis);
      if (!result[row.ticker]) result[row.ticker] = [];
      result[row.ticker].push(parsed);
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/da/:ticker', auth, async (req, res) => {
  try {
    const ticker   = req.params.ticker.toUpperCase();
    const analysis = req.body.analysis;
    if (!analysis || typeof analysis !== 'object') {
      return res.status(400).json({ error: 'analysis object required' });
    }
    await db.execute({
      sql: 'INSERT INTO da_history (ticker, analysis) VALUES (?, ?)',
      args: [ticker, JSON.stringify(analysis)],
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/da/:ticker', auth, async (req, res) => {
  try {
    await db.execute({
      sql: 'DELETE FROM da_history WHERE ticker = ?',
      args: [req.params.ticker.toUpperCase()],
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/da', auth, async (req, res) => {
  try {
    await db.execute('DELETE FROM da_history');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Pre-Screener ──────────────────────────────────────────────────────────────
app.get('/api/ps', auth, async (req, res) => {
  try {
    const { rows } = await db.execute('SELECT session FROM ps_history ORDER BY id ASC');
    res.json(rows.map(r => JSON.parse(r.session)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ps', auth, async (req, res) => {
  try {
    const sessions = req.body.sessions;
    if (!Array.isArray(sessions)) {
      return res.status(400).json({ error: 'sessions array required' });
    }
    const stmts = [{ sql: 'DELETE FROM ps_history', args: [] }];
    sessions.forEach(s => stmts.push({
      sql: 'INSERT INTO ps_history (session) VALUES (?)',
      args: [JSON.stringify(s)],
    }));
    await db.batch(stmts, 'write');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/ps', auth, async (req, res) => {
  try {
    await db.execute('DELETE FROM ps_history');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`SENTINEL server running on port ${PORT}`);
  });
}).catch(e => {
  console.error('Failed to initialise database:', e);
  process.exit(1);
});
