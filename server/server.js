// SENTINEL — History Sync Server
// Node.js + Express + SQLite
// Deploy on Render as a Web Service

const express = require('express');
const Database = require('better-sqlite3');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Auth token — set SENTINEL_TOKEN in Render environment variables ──
const TOKEN = process.env.SENTINEL_TOKEN;
if (!TOKEN) {
  console.error('ERROR: SENTINEL_TOKEN environment variable is not set.');
  process.exit(1);
}

// ── Database — stored at /data/sentinel.db on Render disk ──
const DB_DIR  = process.env.DB_DIR || '/data';
const DB_PATH = path.join(DB_DIR, 'sentinel.db');

// Ensure the data directory exists (Render persistent disk mounts at /data)
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

// ── Schema ──────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS da_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker      TEXT    NOT NULL,
    analysis    TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_da_ticker ON da_history(ticker);

  CREATE TABLE IF NOT EXISTS ps_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session     TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));

// CORS — allow requests from GitHub Pages and localhost
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allowed = [
    'http://localhost',
    'http://127.0.0.1',
    'https://',   // any https origin (covers GitHub Pages)
  ];
  const ok = !origin || allowed.some(a => origin.startsWith(a));
  if (ok) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Sentinel-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Token authentication
function auth(req, res, next) {
  const token = req.headers['x-sentinel-token'];
  if (!token || token !== TOKEN) {
    return res.status(401).json({ error: 'Unauthorised — invalid or missing token' });
  }
  next();
}

// ── Health check (no auth) ───────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ════════════════════════════════════════════════════════════════════════════
// DEEP ANALYSIS HISTORY
// ════════════════════════════════════════════════════════════════════════════

// GET /api/da — load all deep analysis history
// Returns: { ticker: [run, run, ...], ... }
app.get('/api/da', auth, (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT ticker, analysis FROM da_history ORDER BY id ASC'
    ).all();
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

// POST /api/da/:ticker — save a new analysis run for a ticker
// Body: { analysis: { ...result object... } }
app.post('/api/da/:ticker', auth, (req, res) => {
  try {
    const { ticker } = req.params;
    const { analysis } = req.body;
    if (!analysis || typeof analysis !== 'object') {
      return res.status(400).json({ error: 'analysis object required' });
    }
    db.prepare(
      'INSERT INTO da_history (ticker, analysis) VALUES (?, ?)'
    ).run(ticker.toUpperCase(), JSON.stringify(analysis));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/da/:ticker — delete all runs for a ticker
app.delete('/api/da/:ticker', auth, (req, res) => {
  try {
    const { ticker } = req.params;
    db.prepare('DELETE FROM da_history WHERE ticker = ?').run(ticker.toUpperCase());
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/da — delete ALL deep analysis history
app.delete('/api/da', auth, (req, res) => {
  try {
    db.prepare('DELETE FROM da_history').run();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PRE-SCREENER HISTORY
// ════════════════════════════════════════════════════════════════════════════

// GET /api/ps — load all pre-screener sessions
// Returns: [ session, session, ... ]
app.get('/api/ps', auth, (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT session FROM ps_history ORDER BY id ASC'
    ).all();
    res.json(rows.map(r => JSON.parse(r.session)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/ps — save full pre-screener history (replace)
// Body: { sessions: [...] }
app.post('/api/ps', auth, (req, res) => {
  try {
    const { sessions } = req.body;
    if (!Array.isArray(sessions)) {
      return res.status(400).json({ error: 'sessions array required' });
    }
    const insert = db.prepare('INSERT INTO ps_history (session) VALUES (?)');
    db.prepare('DELETE FROM ps_history').run(); // replace all
    const insertMany = db.transaction(arr => {
      arr.forEach(s => insert.run(JSON.stringify(s)));
    });
    insertMany(sessions);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/ps — clear all pre-screener history
app.delete('/api/ps', auth, (req, res) => {
  try {
    db.prepare('DELETE FROM ps_history').run();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`SENTINEL server running on port ${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});
