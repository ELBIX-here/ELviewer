/**
 * Effective number of side-by-side pages for the "단 수" setting.
 * Automatic (0) shows two pages when the reading area is wide and not much taller
 * than it is wide – a landscape window, a tablet on its side or an unfolded foldable –
 * and one page on ordinary phone screens.
 */
export function effectiveColumns(setting: 0 | 1 | 2, width: number, height: number): 1 | 2 {
  if (setting !== 0) return setting;
  return width >= 600 && width >= height * 0.75 ? 2 : 1;
}

/** A run of paragraphs laid out together in page mode: [start, end). */
export type Block = readonly [start: number, end: number];

/**
 * Splits a document into page-mode blocks (only one block is in the DOM at a time).
 *
 * Every block ends with a partly filled page, so block boundaries are put where a
 * short page is natural: at chapter headings (`headings`, ascending paragraph
 * indexes), the way a printed book starts each chapter on a new page. Short
 * chapters are grouped until a block has at least `min` paragraphs; a chapter longer
 * than `max` (or a document without headings) is cut into equal parts of at most `max`.
 */
export function pageBlocks(paraCount: number, headings: readonly number[], min = 120, max = 600): Block[] {
  const out: Block[] = [];
  const cut = (start: number, end: number) => {
    const parts = Math.max(1, Math.ceil((end - start) / max));
    const size = Math.ceil((end - start) / parts);
    for (let s = start; s < end; s += size) out.push([s, Math.min(end, s + size)]);
  };
  let start = 0;
  for (const h of headings) {
    if (h <= start || h >= paraCount) continue;
    if (h - start >= min) {
      cut(start, h);
      start = h;
    }
  }
  if (start < paraCount || out.length === 0) cut(start, Math.max(start + 1, paraCount));
  // A tiny tail (e.g. an epilogue of a few lines) joins the previous block if it fits.
  if (out.length > 1) {
    const [a, b] = [out[out.length - 2], out[out.length - 1]];
    if (b[1] - b[0] < min / 4 && b[1] - a[0] <= max) out.splice(-2, 2, [a[0], b[1]]);
  }
  return out;
}

/** Index of the block containing paragraph `para`. */
export function blockOf(blocks: readonly Block[], para: number): number {
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (blocks[mid][0] <= para) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
