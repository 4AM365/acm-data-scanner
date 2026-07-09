const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const express = require('express');

const PORT = 8080;

// When packaged with pkg, writable files (scan log) live next to the exe;
// static assets are read from the snapshot via __dirname.
const IS_PKG = !!process.pkg;
const DATA_DIR = IS_PKG ? path.dirname(process.execPath) : __dirname;
const SCANS_FILE = path.join(DATA_DIR, 'scans.txt');

const app = express();
app.use(express.json({ limit: '20mb' })); // base64 frame crops go through /api/ocr

app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/tesseract', express.static(path.join(path.dirname(require.resolve('tesseract.js/package.json')), 'dist')));
app.use('/vendor/tesseract-core', express.static(path.dirname(require.resolve('tesseract.js-core/package.json'))));

app.get('/api/log', (_req, res) => {
  res.type('text/plain');
  fs.readFile(SCANS_FILE, 'utf8', (err, data) => res.send(err ? '' : data));
});

// SSE keeps the log panel current if multiple tabs are open.
const sseClients = new Set();
app.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});
function notify() {
  for (const res of sseClients) res.write('event: update\ndata: 1\n\n');
}

app.post('/api/scan', (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const lines = items.map(String).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return res.status(400).json({ error: 'no items' });
  fs.appendFile(SCANS_FILE, lines.join('\n') + '\n', (err) => {
    if (err) return res.status(500).json({ error: err.message });
    notify();
    res.json({ ok: true, count: lines.length });
  });
});

// ---- GPU OCR sidecar (EasyOCR on CUDA) ----
// Best-effort: spawn it if the venv exists, proxy to it, and let the browser
// fall back to Tesseract.js when it isn't available.
const OCR_URL = 'http://127.0.0.1:8765';
const OCR_PY = path.join(__dirname, 'ocr_service', '.venv', 'Scripts', 'python.exe');

function startOcrService() {
  if (!fs.existsSync(OCR_PY)) {
    console.log('  GPU OCR: venv not found, browser will use Tesseract.js fallback');
    return;
  }
  const proc = spawn(OCR_PY, ['service.py'], {
    cwd: path.join(__dirname, 'ocr_service'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUTF8: '1' }, // cp1252 pipes choke on progress-bar glyphs
  });
  proc.stdout.on('data', (b) => process.stdout.write(`  [ocr] ${b}`));
  proc.stderr.on('data', (b) => process.stderr.write(`  [ocr] ${b}`));
  proc.on('exit', (code) => console.log(`  GPU OCR service exited (code ${code})`));
  process.on('exit', () => proc.kill());
}

app.get('/api/ocr/health', async (_req, res) => {
  try {
    const r = await fetch(`${OCR_URL}/health`, { signal: AbortSignal.timeout(1500) });
    res.json(await r.json());
  } catch {
    res.json({ ok: false });
  }
});

app.post('/api/ocr', async (req, res) => {
  try {
    const r = await fetch(`${OCR_URL}/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(30000),
    });
    res.status(r.status).json(await r.json());
  } catch (e) {
    res.status(503).json({ error: 'GPU OCR service unavailable: ' + e.message });
  }
});

app.post('/api/clear', (_req, res) => {
  fs.writeFile(SCANS_FILE, '', (err) => {
    if (err) return res.status(500).json({ error: err.message });
    notify();
    res.json({ ok: true });
  });
});

const server = http.createServer(app);
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Already running (e.g. taskbar icon clicked again) — just open the page.
    console.log('Scanner already running — opening the page.');
    spawn('cmd', ['/c', 'start', '', `http://localhost:${PORT}`], { detached: true, stdio: 'ignore' }).unref();
    process.exit(0);
  }
  throw err;
});

// Bind localhost only: camera + page + data never leave this machine.
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log('\nACM Data Scanner running');
  console.log(`  Scanner:          ${url}`);
  console.log(`  Scan output file: ${SCANS_FILE}`);
  console.log('\n  Keep this window open. Ctrl+C to stop.\n');
  startOcrService();
  // Pop the default browser so the exe is double-click-and-go.
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
});
