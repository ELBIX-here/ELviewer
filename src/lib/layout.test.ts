import { describe, expect, it } from "vitest";
import { blockOf, effectiveColumns, pageBlocks } from "./layout";

const covers = (blocks: readonly (readonly [number, number])[], n: number) => {
  expect(blocks[0][0]).toBe(0);
  expect(blocks[blocks.length - 1][1]).toBe(n);
  for (let i = 1; i < blocks.length; i++) expect(blocks[i][0]).toBe(blocks[i - 1][1]);
};

describe("pageBlocks", () => {
  it("starts blocks at chapter headings so short pages only end chapters", () => {
    const headings = [0, 150, 320, 500];
    const blocks = pageBlocks(700, headings);
    covers(blocks, 700);
    expect(blocks.map((b) => b[0])).toEqual([0, 150, 320, 500]);
  });

  it("groups short chapters until a block is big enough", () => {
    const headings = Array.from({ length: 20 }, (_, i) => i * 40); // a heading every 40 paragraphs
    const blocks = pageBlocks(800, headings, 120, 600);
    covers(blocks, 800);
    for (const [s] of blocks) expect(headings).toContain(s);
    for (const [s, e] of blocks.slice(0, -1)) expect(e - s).toBeGreaterThanOrEqual(120);
  });

  it("cuts long chapters and heading-less text into equal parts within the limit", () => {
    const blocks = pageBlocks(1300, [], 120, 600);
    covers(blocks, 1300);
    expect(blocks).toHaveLength(3);
    for (const [s, e] of blocks) expect(e - s).toBeLessThanOrEqual(600);
  });

  it("folds a tiny tail into the previous block", () => {
    const blocks = pageBlocks(410, [0, 200, 400], 120, 600);
    covers(blocks, 410);
    expect(blocks[blocks.length - 1]).toEqual([200, 410]);
  });

  it("handles empty and one-paragraph documents", () => {
    expect(pageBlocks(0, [])).toEqual([[0, 1]]);
    expect(pageBlocks(1, [0])).toEqual([[0, 1]]);
  });

  it("finds the block of a paragraph", () => {
    const blocks = pageBlocks(700, [0, 150, 320, 500]);
    expect(blockOf(blocks, 0)).toBe(0);
    expect(blockOf(blocks, 149)).toBe(0);
    expect(blockOf(blocks, 150)).toBe(1);
    expect(blockOf(blocks, 699)).toBe(3);
  });
});

describe("effectiveColumns", () => {
  it("uses two pages on wide landscape areas only when automatic", () => {
    expect(effectiveColumns(0, 1200, 800)).toBe(2);
    expect(effectiveColumns(0, 400, 800)).toBe(1);
    expect(effectiveColumns(1, 1200, 800)).toBe(1);
  });
});
