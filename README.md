# ACM Data Scanner

Point a webcam at a module, OCR the numbers, and collect them in a copy-pasteable log.

## Run

```
npm install
npm start
```

The browser opens `http://localhost:8080` automatically. Allow camera access when prompted.

1. Pick the camera in the header dropdown (e.g. **Astra Pro** for the Orbbec RGB stream) — remembered for next time.
2. Align the module's numbers in the green guide box and press **Scan** (or `Space`).
3. Detected numbers appear as chips — click any to deselect junk — then **Add to log** (or `Enter`).
4. The right-hand log panel has **Copy all**; the same lines are written to `scans.txt` next to the app (open in Notepad if you prefer).

The **min digits** setting filters out tokens with fewer digits (e.g. `3` drops stray "1" and "S/N" fragments but keeps part numbers).

Everything is bound to localhost — camera frames, OCR, and scan data never leave the machine. If the camera errors, make sure no other app (e.g. Orbbec depth software) has it open, then re-pick it in the dropdown.

## Build the exe

```
npm i -D @yao-pkg/pkg
npm run build:exe
```

Produces `dist/acm-data-scanner.exe`. Double-click to run; it writes `scans.txt` next to the exe.

## GPU OCR (recommended)

A local EasyOCR sidecar (CRAFT text detection + CRNN recognition on CUDA) gives far better accuracy than the in-browser fallback. One-time setup:

```
cd ocr_service
python -m venv .venv
.venv\Scripts\python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
.venv\Scripts\python -m pip install -r requirements.txt
```

`npm start` auto-launches the sidecar when the venv exists (first run downloads ~100 MB of models). The status line shows which engine handled each scan (`NVIDIA GeForce RTX ... · 140ms`). If the sidecar isn't running, the page silently falls back to in-browser Tesseract.js.

Chips with an amber border are low-confidence reads — double-check them before adding.

## Notes

- The server only serves files, proxies OCR, and appends scan results — everything stays on localhost.
- Tesseract language data is downloaded once during `npm install` so the fallback works without internet.
