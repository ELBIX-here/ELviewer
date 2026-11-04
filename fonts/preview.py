"""Render a side-by-side comparison of Noto Sans KR (Regular) and EL Sans."""

import os
import sys

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "preview.png")
SUFFIX = sys.argv[2] if len(sys.argv) > 2 else ""

ref_path = os.path.join(HERE, "source", "_NotoSansKR-Regular.ttf")
if not os.path.exists(ref_path):
    f = instancer.instantiateVariableFont(TTFont(os.path.join(HERE, "source", "NotoSansKR-VF.ttf")), {"wght": 400})
    f.save(ref_path)

LINES = [
    "가나다라 각낙닥락 값넋닭 읽었다",
    "그러나 지금. 대학교를 졸업한 난 알바 하나",
    "“아, 저 정신병자 새끼 드디어 전역하네.”",
    "ELviewer 123 Hangul reading test",
]

fonts = [
    ("Noto Sans KR Regular", ref_path),
    ("EL Sans Regular", os.path.join(HERE, "dist", f"ELSans-Regular{SUFFIX}.ttf")),
    ("EL Sans Bold", os.path.join(HERE, "dist", f"ELSans-Bold{SUFFIX}.ttf")),
]
fonts = [(n, p) for n, p in fonts if os.path.exists(p)]

W, size = 1500, 44
H = 60 + len(fonts) * (len(LINES) * 64 + 70)
img = Image.new("RGB", (W, H), (28, 29, 32))
d = ImageDraw.Draw(img)
label = ImageFont.truetype("C:/Windows/Fonts/malgun.ttf", 20)
y = 20
for name, path in fonts:
    d.text((30, y), name, fill=(140, 150, 170), font=label)
    y += 34
    f = ImageFont.truetype(path, size)
    for line in LINES:
        d.text((30, y), line, fill=(213, 215, 220), font=f)
        y += 64
    y += 36

# Large detail row to judge terminals.
big = Image.new("RGB", (W, 330), (28, 29, 32))
bd = ImageDraw.Draw(big)
x = 30
for name, path in fonts:
    f = ImageFont.truetype(path, 220)
    bd.text((x, 40), "각ㄱ", fill=(213, 215, 220), font=f)
    x += 490
out = Image.new("RGB", (W, H + 330), (28, 29, 32))
out.paste(img, (0, 0))
out.paste(big, (0, H))
out.save(OUT)
print(OUT)
