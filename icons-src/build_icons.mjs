// Generates every app icon for ELviewer.
//
//   node icons-src/build_icons.mjs
//
// Concept: an hourglass where time turns into knowledge – sand runs out of the top
// bulb and lands as a stack of books in the bottom one. The same drawing is animated
// on the launch screen (src/components/Splash.tsx); keep the two in step.
//
// Construction – "Paper & Ink" (DESIGN.md): the icon is line-art on paper
//   * flat cream (Paper) plate with continuous corners – no gradients, no gloss
//   * the hourglass is a single navy ink line of one weight; caps are the same line
//   * sand (the only color) marks time: sand left on top, the falling stream,
//     and one sand book on a navy book at the bottom – time stacked as knowledge
//   * *-small (≤48px): heavier line, one book, thicker stream
//
// Outputs
//   icons-src/*.svg                        – master SVGs
//   src-tauri/icons/*.png, icon.ico, ...   – Tauri bundle icons
//   src/assets/logo.svg                    – in-app logo
//   Android launcher icons (adaptive + monochrome)

import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "icons-src");
const OUT = join(ROOT, "src-tauri", "icons");

const C = {
  navy: "#1C2640",
  paper: "#F3EAD8",
  sand: "#E8A23C",
};

/** Continuous-corner plate: 112px corners whose curvature eases in over ~1.5× the radius. */
const SQUIRCLE =
  "M168 0H344C442 0 482 6 497 32 512 58 512 98 512 168V344C512 414 512 454 497 480 482 506 442 512 344 512H168C70 512 30 506 15 480 0 454 0 414 0 344V168C0 98 0 58 15 32 30 6 70 0 168 0Z";

/** Hourglass glass (centre line of the ink stroke): top bulb, neck at y=256, bottom bulb. */
const GLASS = "M168 128H344C344 196 292 222 268 256C292 290 344 316 344 384H168C168 316 220 290 244 256C220 222 168 196 168 128Z";
/** Sand left in the top bulb. */
const SAND_TOP = "M206 180H306C296 204 276 222 262 240H250C236 222 216 204 206 180Z";

function glyph({ small, mono = false }) {
  const ink = mono ? "#FFFFFF" : C.navy;
  const sand = mono ? "#FFFFFF" : C.sand;
  const w = small ? 30 : 22;
  const capY = small ? [116, 396] : [120, 392];
  const books = small
    ? `<rect x="196" y="336" width="120" height="30" rx="6" fill="${ink}"/>`
    : `<rect x="192" y="344" width="128" height="22" rx="5" fill="${ink}"/><rect x="206" y="320" width="100" height="20" rx="5" fill="${sand}"/>`;
  return [
    `<path d="${GLASS}" fill="none" stroke="${ink}" stroke-width="${w}" stroke-linejoin="round"/>`,
    `<path d="M150 ${capY[0]}H362M150 ${capY[1]}H362" stroke="${ink}" stroke-width="${w}" stroke-linecap="round"/>`,
    `<path d="${SAND_TOP}" fill="${sand}"/>`,
    `<path d="M256 244V${small ? 330 : 318}" stroke="${sand}" stroke-width="${small ? 12 : 8}" stroke-linecap="round"/>`,
    books,
  ].join("");
}

function svg(small) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><path d="${SQUIRCLE}" fill="${C.paper}"/>${glyph({ small })}</svg>`;
}

const masters = {
  "icon-main.svg": svg(false),
  "icon-main-small.svg": svg(true),
};
mkdirSync(SRC, { recursive: true });
for (const [name, s] of Object.entries(masters)) writeFileSync(join(SRC, name), s);

function png(svgText, size) {
  return new Resvg(svgText, { fitTo: { mode: "width", value: size }, background: "rgba(0,0,0,0)" }).render().asPng();
}

// main plate icon: detailed above 32px, simplified at 32px and below (as on the size ramp)
const main = (size) => png(size <= 32 ? masters["icon-main-small.svg"] : masters["icon-main.svg"], size);
// Windows .ico: the plate icon as well (one shape everywhere), simplified at 48px and below
const win = (size) => png(size <= 48 ? masters["icon-main-small.svg"] : masters["icon-main.svg"], size);

const pngs = {
  "32x32.png": main(32),
  "64x64.png": main(64),
  "128x128.png": main(128),
  "128x128@2x.png": main(256),
  "icon.png": main(512),
  "Square30x30Logo.png": main(30),
  "Square44x44Logo.png": main(44),
  "Square71x71Logo.png": main(71),
  "Square89x89Logo.png": main(89),
  "Square107x107Logo.png": main(107),
  "Square142x142Logo.png": main(142),
  "Square150x150Logo.png": main(150),
  "Square284x284Logo.png": main(284),
  "Square310x310Logo.png": main(310),
  "StoreLogo.png": main(50),
};
for (const [name, buf] of Object.entries(pngs)) writeFileSync(join(OUT, name), buf);

// .ico with a hand-picked image per size (PNG-compressed entries, Vista+).
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}
const icoSizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
writeFileSync(join(OUT, "icon.ico"), ico(icoSizes.map((size) => ({ size, data: win(size) }))));

// in-app logo
writeFileSync(join(ROOT, "src", "assets", "logo.svg"), masters["icon-main.svg"]);

// ---------------------------------------------------------------------------
// Android launcher icons (src-tauri/gen/android/app/src/main/res)
//   adaptive (API 26+): navy background + glyph foreground on the 108dp canvas, kept
//   inside the 66dp safe zone so every launcher mask (circle, squircle, teardrop)
//   shows the whole hourglass; monochrome layer for Android 13 themed icons
//   legacy (API 24/25): the plate icon, square and round
const RES = join(ROOT, "src-tauri", "gen", "android", "app", "src", "main", "res");
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const GLYPH_SCALE = 0.16; // dp per master unit: the glyph's corners stay ~34dp from the centre

function adaptiveLayer(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="108" height="108"><g transform="translate(54 54) scale(${GLYPH_SCALE}) translate(-256 -256)">${inner}</g></svg>`;
}
const fgSvg = adaptiveLayer(glyph({ small: false }));
// Themed icons are tinted by the system: only the alpha channel matters.
const monoSvg = adaptiveLayer(glyph({ small: true, mono: true }));
const roundSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><circle cx="256" cy="256" r="256" fill="${C.paper}"/><g transform="translate(256 256) scale(0.86) translate(-256 -256)">${glyph({ small: false })}</g></svg>`;

for (const [dpi, f] of Object.entries(DENSITIES)) {
  const dir = join(RES, `mipmap-${dpi}`);
  mkdirSync(dir, { recursive: true });
  const legacy = Math.round(48 * f);
  const layer = Math.round(108 * f);
  writeFileSync(join(dir, "ic_launcher.png"), main(legacy));
  writeFileSync(join(dir, "ic_launcher_round.png"), png(roundSvg, legacy));
  writeFileSync(join(dir, "ic_launcher_foreground.png"), png(fgSvg, layer));
  writeFileSync(join(dir, "ic_launcher_monochrome.png"), png(monoSvg, layer));
}
const adaptiveXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />
</adaptive-icon>
`;
mkdirSync(join(RES, "mipmap-anydpi-v26"), { recursive: true });
writeFileSync(join(RES, "mipmap-anydpi-v26", "ic_launcher.xml"), adaptiveXml);
writeFileSync(join(RES, "mipmap-anydpi-v26", "ic_launcher_round.xml"), adaptiveXml);
writeFileSync(
  join(RES, "values", "ic_launcher_background.xml"),
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${C.paper}</color>\n</resources>\n`,
);
// Play Store listing icon
writeFileSync(join(ROOT, "src-tauri", "icons", "android-playstore-512.png"), main(512));

// preview sheet for eyeballing
const sheetSizes = [256, 128, 64, 48, 32, 24, 16];
console.log("written:", Object.keys(masters).length, "svgs,", Object.keys(pngs).length, "pngs, icon.ico (", icoSizes.join(","), ")");
export { main, win, sheetSizes };
