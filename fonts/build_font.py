"""Build "EL Sans" – ELviewer's reading typeface – from Noto Sans KR.

Changes from the source font:
  1. Slightly heavier: instanced from the variable font at a higher weight.
  2. Rounded terminals: every glyph outline is morphologically "opened"
     (eroded then dilated by the same radius with round joins), which rounds
     every convex corner – stroke ends, corners of ㄱ ㄴ ㅁ … – while keeping
     stems at their original thickness.
  3. Narrower syllables with a final consonant (받침): those glyphs are
     condensed horizontally together with their advance width.

Hanja are dropped (the reader falls back to the system font for them) to keep
the font small enough to ship inside the app.

Usage:  python build_font.py [--quick]
Output: fonts/dist/ELSans-Regular.{ttf,woff2}, ELSans-Bold.{ttf,woff2}

License: the source is SIL OFL 1.1 with Reserved Font Name "Source", and
"Noto" is a trademark – the derivative therefore uses its own name.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor

import pathops
from fontTools import subset
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "source", "NotoSansKR-VF.ttf")
DIST = os.path.join(HERE, "dist")

FAMILY = "EL Sans"
FAMILY_KO = "엘 산스"
PS_FAMILY = "ELSans"

# name -> (variable-font wght, OS/2 weight class, corner radius in font units)
STYLES = {
    "Regular": (470, 400, 28),
    "Bold": (730, 700, 30),
}
# Horizontal scale for Hangul syllables that carry a final consonant.
BATCHIM_SCALE = 0.94

UNICODES = (
    list(range(0x0020, 0x007F))  # Basic Latin
    + list(range(0x00A0, 0x0180))  # Latin-1 + Latin Extended-A
    + list(range(0x2000, 0x2070))  # General punctuation
    + list(range(0x2070, 0x20D0))  # super/subscripts, currency
    + list(range(0x2100, 0x2200))  # letterlike, number forms, arrows
    + list(range(0x2200, 0x2300))  # math operators
    + list(range(0x2460, 0x2500))  # enclosed alphanumerics ①
    + list(range(0x2500, 0x2600))  # box drawing, blocks, geometric shapes
    + list(range(0x2600, 0x2700))  # misc symbols ★♥
    + list(range(0x3000, 0x3040))  # CJK symbols and punctuation 「」『』
    + list(range(0x1100, 0x1200))  # Hangul Jamo
    + list(range(0x3130, 0x3190))  # Hangul compatibility Jamo ㄱㅏ
    + list(range(0x3200, 0x3300))  # enclosed CJK ㈜
    + list(range(0xA960, 0xA980))
    + list(range(0xAC00, 0xD7A4))  # Hangul syllables
    + list(range(0xD7B0, 0xD800))
    + list(range(0xFF00, 0xFFF0))  # half/fullwidth forms
)


def has_batchim(cp: int) -> bool:
    return 0xAC00 <= cp <= 0xD7A3 and (cp - 0xAC00) % 28 != 0


def to_path(recording: list) -> pathops.Path:
    path = pathops.Path()
    pen = path.getPen()
    for op, args in recording:
        getattr(pen, op)(*args)
    return path


def morph(recording: list, radius: float, xscale: float) -> list:
    """Condense (optional) then round the outline. Returns quadratic pen ops."""
    if xscale != 1.0:
        scaled = RecordingPen()
        tp = TransformPen(scaled, (xscale, 0, 0, 1, 0, 0))
        for op, args in recording:
            getattr(tp, op)(*args)
        recording = scaled.value

    path = to_path(recording)
    path.simplify(fix_winding=True)
    if radius > 0 and path.area > 0:
        width = radius * 2
        border = pathops.Path()
        border.addPath(path)
        border.stroke(width, pathops.LineCap.ROUND_CAP, pathops.LineJoin.ROUND_JOIN, 4)
        border.convertConicsToQuads()
        eroded = pathops.op(path, border, pathops.PathOp.DIFFERENCE, fix_winding=True)
        # Features thinner than 2*radius disappear on erosion (thin dots, hairlines).
        # Keep the original shape for those rather than dropping ink.
        if eroded.area < path.area * 0.15:
            result = path
        else:
            grow = pathops.Path()
            grow.addPath(eroded)
            grow.stroke(width, pathops.LineCap.ROUND_CAP, pathops.LineJoin.ROUND_JOIN, 4)
            grow.convertConicsToQuads()
            result = pathops.op(eroded, grow, pathops.PathOp.UNION, fix_winding=True)
            # Put back any contour the opening wiped out entirely (e.g. a tiny dot).
            lost = pathops.op(path, result, pathops.PathOp.DIFFERENCE, fix_winding=True)
            if lost.area > path.area * 0.08:
                result = pathops.op(result, lost, pathops.PathOp.UNION, fix_winding=True)
        path = result
    path.convertConicsToQuads()
    out = RecordingPen()
    path.draw(Cu2QuPen(out, max_err=1.0, reverse_direction=True))
    return out.value


def work(job):
    name, recording, radius, xscale = job
    try:
        return name, morph(recording, radius, xscale), None
    except Exception as e:
        # Boolean ops occasionally fail on degenerate outlines; keep the glyph
        # condensed (its advance is narrowed regardless) but unrounded.
        try:
            return name, morph(recording, 0, xscale), f"unrounded ({type(e).__name__})"
        except Exception as e2:
            return name, None, f"{type(e2).__name__}: {e2}"


def set_names(font: TTFont, style: str) -> None:
    name = font["name"]
    full = f"{FAMILY} {style}"
    ps = f"{PS_FAMILY}-{style}"
    ribbi = style in ("Regular", "Bold")
    records = {
        0: "Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'. "
        "Modified for ELviewer (rounded terminals, heavier weight, narrower final-consonant syllables).",
        1: FAMILY,
        2: style,
        3: f"ELviewer:{ps}:2026",
        4: full,
        5: "Version 1.000",
        6: ps,
        13: "This Font Software is licensed under the SIL Open Font License, Version 1.1.",
        14: "https://openfontlicense.org",
    }
    name.names = [n for n in name.names if n.nameID not in (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 16, 17, 21, 22, 25)]
    for nid, value in records.items():
        name.setName(value, nid, 3, 1, 0x409)
    # Korean names
    name.setName(FAMILY_KO, 1, 3, 1, 0x412)
    name.setName(f"{FAMILY_KO} {'보통' if style == 'Regular' else '굵게'}", 4, 3, 1, 0x412)
    if not ribbi:
        name.setName(FAMILY, 16, 3, 1, 0x409)
        name.setName(style, 17, 3, 1, 0x409)
    if "STAT" in font:
        del font["STAT"]


def build(style: str, quick: bool) -> None:
    wght, weight_class, radius = STYLES[style]
    t0 = time.time()
    font = TTFont(SRC)

    opts = subset.Options()
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.name_languages = ["*"]
    opts.notdef_outline = True
    opts.glyph_names = False
    opts.hinting = False
    unicodes = UNICODES if not quick else list(range(0x20, 0x7F)) + list(range(0xAC00, 0xAC00 + 600)) + [0xD55C, 0xAE00]
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=unicodes)
    sub.subset(font)
    print(f"[{style}] subset: {len(font.getGlyphOrder())} glyphs ({time.time() - t0:.1f}s)")

    font = instancer.instantiateVariableFont(font, {"wght": wght}, updateFontNames=False)
    print(f"[{style}] instanced at wght={wght} ({time.time() - t0:.1f}s)")

    glyph_set = font.getGlyphSet()
    cmap = font.getBestCmap()
    batchim = {g for cp, g in cmap.items() if has_batchim(cp)}
    hmtx = font["hmtx"]

    jobs = []
    for gname in font.getGlyphOrder():
        rec = RecordingPen()
        glyph_set[gname].draw(rec)  # decomposes components
        if not rec.value:
            continue
        jobs.append((gname, rec.value, radius, BATCHIM_SCALE if gname in batchim else 1.0))

    glyf = font["glyf"]
    failed = 0
    with ProcessPoolExecutor(max_workers=max(1, (os.cpu_count() or 2) - 1)) as ex:
        for i, (gname, ops, err) in enumerate(ex.map(work, jobs, chunksize=64)):
            if err:
                failed += 1
                if failed < 10:
                    print(f"  ! {gname}: {err}")
                if ops is None:
                    continue
            pen = TTGlyphPen(None)
            for op, args in ops:
                getattr(pen, op)(*args)
            glyf[gname] = pen.glyph()
            if (i + 1) % 2000 == 0:
                print(f"  {i + 1}/{len(jobs)} ({time.time() - t0:.0f}s)")

    # Narrow the advance of 받침 syllables to match their condensed outlines.
    for gname in batchim:
        adv, lsb = hmtx[gname]
        hmtx[gname] = (round(adv * BATCHIM_SCALE), lsb)
    # Recompute bounds / lsb for every glyph.
    for gname in font.getGlyphOrder():
        g = glyf[gname]
        g.recalcBounds(glyf)
        adv, _ = hmtx[gname]
        hmtx[gname] = (adv, getattr(g, "xMin", 0) if g.numberOfContours else 0)

    for tag in ("prep", "fpgm", "cvt ", "hdmx", "LTSH", "VDMX"):
        if tag in font:
            del font[tag]
    font["maxp"].recalc(font) if hasattr(font["maxp"], "recalc") else None

    os2 = font["OS/2"]
    os2.usWeightClass = weight_class
    os2.fsSelection = (os2.fsSelection & ~0b1100001) | (0b100000 if style == "Bold" else 0b1000000)
    font["head"].macStyle = 1 if style == "Bold" else 0
    set_names(font, style)

    os.makedirs(DIST, exist_ok=True)
    base = os.path.join(DIST, f"{PS_FAMILY}-{style}{'-quick' if quick else ''}")
    font.save(base + ".ttf")
    font.flavor = "woff2"
    font.save(base + ".woff2")
    print(
        f"[{style}] done in {time.time() - t0:.0f}s - {failed} failures - "
        f"ttf {os.path.getsize(base + '.ttf') / 1e6:.1f} MB, woff2 {os.path.getsize(base + '.woff2') / 1e6:.1f} MB"
    )


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="small subset for previewing parameters")
    ap.add_argument("--style", choices=list(STYLES), action="append")
    args = ap.parse_args()
    for s in args.style or list(STYLES):
        build(s, args.quick)
    sys.exit(0)
