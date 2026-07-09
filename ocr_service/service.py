"""GPU OCR sidecar: CRAFT text detection + CRNN recognition via EasyOCR,
plus TrOCR (transformer, handwriting-trained) reading the same regions.

The Node server proxies /api/ocr here; the browser falls back to Tesseract.js
if this service isn't running.
"""
import base64
import io
import time

import easyocr
import numpy as np
import torch
import torch.nn.functional as F
import uvicorn
from fastapi import FastAPI
from PIL import Image
from pydantic import BaseModel

app = FastAPI()

GPU = torch.cuda.is_available()
DEVICE = torch.cuda.get_device_name(0) if GPU else "cpu"
print(f"loading EasyOCR (device: {DEVICE}) ...", flush=True)
# verbose=False: the download progress bar prints box-drawing chars that crash
# on Windows cp1252 pipes.
reader = easyocr.Reader(["en"], gpu=GPU, verbose=False)
print("EasyOCR ready", flush=True)

print("loading TrOCR handwriting model ...", flush=True)
try:
    from transformers import TrOCRProcessor, VisionEncoderDecoderModel

    trocr_processor = TrOCRProcessor.from_pretrained("microsoft/trocr-base-handwritten")
    trocr = VisionEncoderDecoderModel.from_pretrained("microsoft/trocr-base-handwritten")
    if GPU:
        trocr = trocr.half().cuda()
    trocr.eval()
    print("TrOCR ready", flush=True)
except Exception as e:  # missing package/model — printed OCR still works
    trocr = None
    print(f"TrOCR unavailable ({e}) — handwriting recognition disabled", flush=True)


class OcrRequest(BaseModel):
    image: str  # base64-encoded PNG/JPEG


@app.get("/health")
def health():
    return {"ok": True, "gpu": GPU, "device": DEVICE, "handwriting": trocr is not None}


def box_bounds(box, w, h, pad=4):
    xs = [p[0] for p in box]
    ys = [p[1] for p in box]
    x0, x1 = max(0, int(min(xs)) - pad), min(w, int(max(xs)) + pad)
    y0, y1 = max(0, int(min(ys)) - pad), min(h, int(max(ys)) + pad)
    return x0, y0, x1, y1


def trocr_read(img, boxes):
    """Batch-read detected regions with the handwriting model."""
    crops, kept = [], []
    h, w = img.shape[:2]
    for box in boxes:
        x0, y0, x1, y1 = box_bounds(box, w, h)
        if x1 - x0 < 8 or y1 - y0 < 8:
            continue
        crops.append(Image.fromarray(img[y0:y1, x0:x1]))
        kept.append(box)
    if not crops:
        return []
    with torch.no_grad():
        pix = trocr_processor(images=crops, return_tensors="pt").pixel_values
        if GPU:
            pix = pix.half().cuda()
        out = trocr.generate(
            pix, max_new_tokens=32, output_scores=True, return_dict_in_generate=True
        )
        texts = trocr_processor.batch_decode(out.sequences, skip_special_tokens=True)
        pad_id = trocr_processor.tokenizer.pad_token_id
        items = []
        for b, (text, box) in enumerate(zip(texts, kept)):
            probs = []
            for t, step in enumerate(out.scores):
                tok = out.sequences[b, t + 1]
                if tok == pad_id:
                    break
                probs.append(F.softmax(step[b].float(), dim=-1)[tok].item())
            conf = sum(probs) / len(probs) if probs else 0.0
            if text.strip():
                items.append(
                    {
                        "text": text.strip(),
                        "conf": round(conf, 3),
                        "box": [[float(x), float(y)] for x, y in box],
                        "engine": "trocr",
                    }
                )
    return items


@app.post("/ocr")
def ocr(req: OcrRequest):
    img = np.array(Image.open(io.BytesIO(base64.b64decode(req.image))).convert("RGB"))
    t0 = time.perf_counter()
    # rotation_info: also try rotated variants and keep the best-confidence read —
    # phone-as-webcam feeds flip orientation when the phone moves.
    results = reader.readtext(img, rotation_info=[90, 180, 270])
    items = [
        {
            "text": text,
            "conf": round(float(conf), 3),
            "box": [[float(x), float(y)] for x, y in box],
            "engine": "easyocr",
        }
        for box, text, conf in results
    ]
    if trocr is not None and results:
        items += trocr_read(img, [r[0] for r in results])
    ms = round((time.perf_counter() - t0) * 1000)
    return {"ms": ms, "device": DEVICE, "items": items}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")
