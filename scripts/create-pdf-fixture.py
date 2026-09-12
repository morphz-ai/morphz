"""Regenerate the non-personal PDF reader test fixture (requires reportlab)."""
from pathlib import Path
from reportlab.pdfgen.canvas import Canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont

output = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "reader.pdf"
output.parent.mkdir(parents=True, exist_ok=True)
pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
doc = Canvas(str(output), pagesize=(595, 842), pageCompression=1, invariant=1)
doc.setTitle("Morphz PDF reader fixture")
for number, heading, detail in [
    (1, "DESIGN NOTES", "A source stays intact when a reader adds an annotation."),
    (2, "REVIEW CHECKLIST", "The second page contains the unique phrase: durable butterfly."),
]:
    doc.setFillColorRGB(.08, .10, .12)
    doc.setFont("Helvetica-Bold", 11)
    doc.drawString(48, 785, "MORPHZ / TEST DOCUMENT")
    doc.setFont("Helvetica-Bold", 26)
    doc.drawString(48, 707, heading)
    doc.setFillColorRGB(.02, .52, .6)
    doc.rect(48, 672, 72, 3, fill=1, stroke=0)
    doc.setFillColorRGB(.12, .15, .18)
    doc.setFont("Helvetica", 12)
    doc.drawString(48, 625, detail)
    doc.setFont("STSong-Light", 14)
    doc.drawString(48, 574, "这是一份合成测试资料，不包含个人信息。")
    doc.setFont("Helvetica", 10)
    doc.drawString(48, 46, f"Page {number} / 2")
    doc.showPage()
doc.save()
print(f"Created synthetic PDF: {output}")
