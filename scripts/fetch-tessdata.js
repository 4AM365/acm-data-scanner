// Downloads the English OCR language data so the app works with no internet.
// Runs on npm install; if it fails, the page falls back to the CDN at runtime.
const fs = require('fs');
const path = require('path');
const https = require('https');

const URL = 'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz';
const DEST_DIR = path.join(__dirname, '..', 'public', 'tessdata');
const DEST = path.join(DEST_DIR, 'eng.traineddata.gz');

if (fs.existsSync(DEST) && fs.statSync(DEST).size > 1_000_000) {
  console.log('tessdata: eng.traineddata.gz already present, skipping download');
  process.exit(0);
}

fs.mkdirSync(DEST_DIR, { recursive: true });

function download(url, dest, redirects = 0) {
  if (redirects > 5) return fail(new Error('too many redirects'));
  https.get(url, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      return download(res.headers.location, dest, redirects + 1);
    }
    if (res.statusCode !== 200) {
      res.resume();
      return fail(new Error(`HTTP ${res.statusCode}`));
    }
    const out = fs.createWriteStream(dest);
    res.pipe(out);
    out.on('finish', () => {
      out.close();
      console.log(`tessdata: downloaded eng.traineddata.gz (${(fs.statSync(dest).size / 1e6).toFixed(1)} MB)`);
    });
    out.on('error', fail);
  }).on('error', fail);
}

function fail(err) {
  // Non-fatal: the scanner page falls back to the CDN if this file is missing.
  console.warn(`tessdata: download failed (${err.message}) — scanner will use CDN language data instead`);
  try { fs.unlinkSync(DEST); } catch {}
  process.exit(0);
}

download(URL, DEST);
