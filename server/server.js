// SENTINEL — History Sync Server
// Node.js + Express + sql.js (pure JS SQLite, no native compilation needed)

const express = require('express');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Auth token ───────────────────────────────────────────────────────────────
const TOKEN = process.env.SENTINEL_TOKEN;
if (!TOKEN) {
  console.error('ERROR: SENTINEL_TOKEN environment variable is not set.');
  process.exit(1);
}

// ── Database setup ───────────────────────────────────────────────────────────
const DB_DIR  = process.env.DB_DIR || '/tmp';
const DB_PATH = path.join(DB_DIR, 'sentinel.db');

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// sql.js initialisation — load existing DB file or create fresh
let db;
const initSqlJs = require('sql.js');

async function initDB() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    console.log('Loaded existing database from', DB_PATH);
  } else {
    db = new SQL.Database();
    console.log('Created new database at', DB_PATH);
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS da_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker     TEXT NOT NULL,
      analysis   TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_da_ticker ON da_history(ticker);

    CREATE TABLE IF NOT EXISTS ps_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  saveDB(); // persist initial schema
}

// Save DB to disk after every write
function saveDB() {
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) {
    console.error('Failed to save DB:', e.message);
  }
}

// Query helpers
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function run(sql, params = []) {
  db.run(sql, params);
  saveDB();
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
app.get('/api/da', auth, (req, res) => {
  try {
    const rows = all('SELECT ticker, analysis FROM da_history ORDER BY id ASC');
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

app.post('/api/da/:ticker', auth, (req, res) => {
  try {
    const ticker   = req.params.ticker.toUpperCase();
    const analysis = req.body.analysis;
    if (!analysis || typeof analysis !== 'object') {
      return res.status(400).json({ error: 'analysis object required' });
    }
    run('INSERT INTO da_history (ticker, analysis) VALUES (?, ?)',
        [ticker, JSON.stringify(analysis)]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/da/:ticker', auth, (req, res) => {
  try {
    run('DELETE FROM da_history WHERE ticker = ?',
        [req.params.ticker.toUpperCase()]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/da', auth, (req, res) => {
  try {
    run('DELETE FROM da_history');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Pre-Screener ──────────────────────────────────────────────────────────────
app.get('/api/ps', auth, (req, res) => {
  try {
    const rows = all('SELECT session FROM ps_history ORDER BY id ASC');
    res.json(rows.map(r => JSON.parse(r.session)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ps', auth, (req, res) => {
  try {
    const sessions = req.body.sessions;
    if (!Array.isArray(sessions)) {
      return res.status(400).json({ error: 'sessions array required' });
    }
    run('DELETE FROM ps_history');
    sessions.forEach(s => {
      run('INSERT INTO ps_history (session) VALUES (?)', [JSON.stringify(s)]);
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/ps', auth, (req, res) => {
  try {
    run('DELETE FROM ps_history');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`SENTINEL server running on port ${PORT}`);
    console.log(`Database: ${DB_PATH}`);
  });
}).catch(e => {
  console.error('Failed to initialise database:', e);
  process.exit(1);
});
