"""Synthetic image-only PDF; never reads user books. Needs Pillow/reportlab/pypdf.

Usage: python reader-scan-fixture.py <output-directory> <Chinese-font-file> [face-index]
The JSON is ground truth, not OCR output. No font file is redistributed.
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from pypdf import PdfReader

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
font = ImageFont.truetype(sys.argv[2], 42, index=int(sys.argv[3]) if len(sys.argv) > 3 else 0)
pages = []


def horizontal(lines, columns=False):
    im = Image.new("RGB", (1200, 1600), "white")
    draw = ImageDraw.Draw(im)
    for n, text in enumerate(lines):
        x = 80 if not columns or n < len(lines) // 2 else 650
        row = n if not columns else n % (len(lines) // 2)
        draw.text((x, 120 + row * 95), text, fill="#242424", font=font)
    return im


lines = ["合成阅读材料", "兼听则明，偏信则暗。", "先读原文，再形成自己的判断。", "识别文字仍需对照原页核实。"]
pages.append((horizontal(lines), {"layout": "horizontal", "lines": lines}))
lines = ["左栏第一段", "多听不等于全信", "先比较证据", "再形成判断", "右栏第一段", "保持独立思考", "不要急于结论", "记录自己的疑问"]
pages.append((horizontal(lines, True), {"layout": "columns", "lines": lines}))
lines = ["兼聽則明偏信則暗", "君子和而不同", "學而不思則罔"]
im = Image.new("RGB", (1200, 1600), "white")
draw = ImageDraw.Draw(im)
for n, text in enumerate(lines):
    for row, char in enumerate(text):
        draw.text((920 - n * 150, 130 + row * 52), char, font=font, fill="#242424")
pages.append((im, {"layout": "vertical", "lines": lines}))
lines = ["低清晰度合成扫描", "文字有错漏时应回到原页。", "不要将识别分数当成正确率。"]
im = horizontal(lines).resize((540, 720)).resize((1200, 1600)).filter(ImageFilter.GaussianBlur(0.8))
im = im.rotate(1.5, resample=Image.Resampling.BICUBIC, fillcolor="white")
pages.append((im, {"layout": "horizontal", "lines": lines, "degraded": True}))

pdf = out / "TEST-OCR扫描验收.pdf"
writer = canvas.Canvas(str(pdf), pagesize=(600, 800), pageCompression=1)
writer.setTitle("TEST OCR 合成扫描验收")
for number, (im, _) in enumerate(pages, 1):
    for char in "".join(pages[number - 1][1]["lines"]):
        assert char.isspace() or font.getmask(char).getbbox(), f"Font does not render {char}"
    im.save(out / f"scan-{number}.png")
    writer.drawImage(ImageReader(im), 0, 0, width=600, height=800)
    writer.showPage()
writer.save()
reader = PdfReader(pdf)
assert len(reader.pages) == len(pages)
assert all(not page.extract_text().strip() for page in reader.pages), "Fixture must have no hidden text layer"
(out / "ground-truth.json").write_text(json.dumps([p[1] for p in pages], ensure_ascii=False, indent=2))
print(pdf)
