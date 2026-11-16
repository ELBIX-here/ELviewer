import { describe, expect, it, vi } from "vitest";
import { markdownToDoc } from "./markdown";
import { makeImageLoader, normalizePath } from "./rich";
import type { Entry } from "../types";

describe("markdown pictures and tables", () => {
  it("makes a picture line a block", () => {
    const doc = markdownToDoc('글\n\n![삽화 *하나*](imgs/one.png "제목")\n\n끝');
    expect(doc.text.split("\n")).toEqual(["글", "[그림: 삽화 하나]", "끝"]);
    expect(doc.blocks.get(1)).toEqual({ kind: "img", src: "imgs/one.png", alt: "삽화 하나" });
  });

  it("makes a table one block with its header row", () => {
    const doc = markdownToDoc("앞\n\n| 이름 | 값 |\n|---|---:|\n| **모래** | a\\|b |\n\n뒤");
    expect(doc.text.split("\n")).toEqual(["앞", "이름 · 값 / 모래 · a|b", "뒤"]);
    expect(doc.blocks.get(1)).toEqual({
      kind: "table",
      rows: [
        { cells: ["이름", "값"], head: [true, true] },
        { cells: ["모래", "a|b"], head: [false, false] },
      ],
    });
  });
});

describe("picture loading", () => {
  it("normalizes paths", () => {
    expect(normalizePath("C:\\Novels\\책/../그림/./A.PNG")).toBe("c:/novels/그림/a.png");
  });

  const entry = (over: Partial<Entry>): Entry => ({ id: "", name: "", dir: "", root: "", ext: "md", kind: "text", size: 0, mtime: 0, inArchive: false, ...over });
  globalThis.URL.createObjectURL ??= () => "blob:x";

  it("finds pictures among the library files next to the document", async () => {
    const doc = entry({ id: '{"uri":"content://doc"}', name: "책.md", dir: "Novels\\책" });
    const pic = entry({ id: '{"uri":"content://pic"}', name: "a b.png", dir: "Novels\\책\\img", kind: "image", ext: "png" });
    const read = vi.fn(async () => new Uint8Array([1]));
    const loader = makeImageLoader(doc, [pic], read);
    expect(await loader.load("img/a%20b.png")).toMatch(/^blob:/);
    expect(read).toHaveBeenCalledWith(pic.id);
    // Not in the library and not a plain path: nothing to read.
    expect(await loader.load("img/none.png")).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads a sibling file directly for a plain local path, and refuses non-pictures", async () => {
    const doc = entry({ id: "C:\\Novels\\책\\1.html", name: "1.html", dir: "C:\\Novels\\책" });
    const read = vi.fn(async () => new Uint8Array([1]));
    const loader = makeImageLoader(doc, [], read);
    await loader.load("../그림/a.jpg?v=2");
    expect(read).toHaveBeenCalledWith("C:\\Novels\\그림\\a.jpg");
    expect(await loader.load("secret.txt")).toBeNull();
    expect(await loader.load("file:///C:/x.png")).toBeNull();
    expect(await loader.load("data:image/png;base64,AA")).toBe("data:image/png;base64,AA");
    expect(read).toHaveBeenCalledTimes(1);
  });
});
