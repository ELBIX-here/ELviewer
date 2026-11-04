import { describe, expect, it } from "vitest";
import { buildDoc, detectToc, formatAgo, formatPct, paraAtOffset, searchText } from "./text";
import { naturalCompare, stripExt, baseName } from "./sort";

describe("buildDoc", () => {
  it("collapses runs of blank lines and trims trailing blanks", () => {
    const d = buildDoc("가\n\n\n\n나\n\n", true, "UTF-8");
    expect(d.paras).toEqual(["가", "", "나"]);
  });

  it("keeps blank lines when not collapsing", () => {
    expect(buildDoc("가\n\n\n나", false, "UTF-8").paras).toEqual(["가", "", "", "나"]);
  });

  it("records cumulative character offsets per paragraph", () => {
    const d = buildDoc("abc\nde\nf", false, "UTF-8");
    expect(Array.from(d.cum)).toEqual([0, 4, 7, 9]);
    expect(d.total).toBe(9);
    expect(paraAtOffset(d.cum, 0)).toBe(0);
    expect(paraAtOffset(d.cum, 5)).toBe(1);
    expect(paraAtOffset(d.cum, 8)).toBe(2);
  });
});

describe("detectToc", () => {
  it("finds web-novel chapter headings", () => {
    const paras = ["프롤로그", "본문입니다.", "1화. 시작", "본문.", "제 2화 귀환", "본문.", "에필로그"];
    expect(detectToc(paras).map((t) => t.para)).toEqual([0, 2, 4, 6]);
  });

  it("ignores chapter-like numbers inside sentences", () => {
    const paras = ["1화", "서버당 1회 구입 가능합니다!", "2화", "그는 3장의 편지를 꺼냈다, 그리고 웃었다."];
    expect(detectToc(paras).map((t) => t.label)).toEqual(["1화", "2화"]);
  });

  it("treats a repeated divider line as one heading at most", () => {
    const paras = ["1화", "1화", "본문", "2화"];
    expect(detectToc(paras).map((t) => t.para)).toEqual([0, 3]);
  });
});

describe("searchText", () => {
  it("is case-insensitive and returns a snippet around each hit", () => {
    const hits = searchText(["Hello world, hello again", "nothing"], "HELLO");
    expect(hits.map((h) => [h.para, h.offset])).toEqual([
      [0, 0],
      [0, 13],
    ]);
    expect(hits[0].snippet).toContain("Hello");
  });

  it("respects the hit limit and an empty query", () => {
    expect(searchText(["aaaa"], "a", 2)).toHaveLength(2);
    expect(searchText(["aaaa"], "")).toEqual([]);
  });
});

describe("formatting", () => {
  it("clamps percentages", () => {
    expect(formatPct(0.4567)).toBe("45.7%");
    expect(formatPct(2)).toBe("100.0%");
    expect(formatPct(-1)).toBe("0.0%");
  });

  it("describes elapsed time in Korean", () => {
    const now = 1_800_000_000_000;
    expect(formatAgo(0, now)).toBe("기록 없음");
    expect(formatAgo(now - 10_000, now)).toBe("방금");
    expect(formatAgo(now - 5 * 60_000, now)).toBe("5분 전");
    expect(formatAgo(now - 3 * 3600_000, now)).toBe("3시간 전");
    expect(formatAgo(now - 30 * 3600_000, now)).toBe("어제");
    expect(formatAgo(now - 4 * 86400_000, now)).toBe("4일 전");
  });
});

describe("sorting and names", () => {
  it("orders volume numbers naturally", () => {
    const names = ["10권.txt", "2권.txt", "1권.txt"];
    expect([...names].sort(naturalCompare)).toEqual(["1권.txt", "2권.txt", "10권.txt"]);
  });

  it("splits paths and extensions", () => {
    expect(baseName("C:\\소설\\책.txt")).toBe("책.txt");
    expect(baseName("a.zip|폴더/b.txt")).toBe("b.txt");
    expect(stripExt("책.part1.txt")).toBe("책.part1");
    expect(stripExt(".hidden")).toBe(".hidden");
  });
});
