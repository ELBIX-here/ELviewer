import { describe, expect, it } from "vitest";
import { applyRules, reflow, splitSentences } from "./textPrep";
import type { ReplaceRule } from "../types";

const rule = (r: Partial<ReplaceRule>): ReplaceRule => ({ id: "r", find: "", replace: "", regex: false, enabled: true, ...r });

describe("applyRules", () => {
  it("treats plain rules literally (no regex metacharacters)", () => {
    const res = applyRules("a.b axb a.b", [rule({ find: "a.b", replace: "X" })]);
    expect(res.text).toBe("X axb X");
    expect(res.counts.r).toBe(2);
  });

  it("expands $1 / $& in regex rules", () => {
    const res = applyRules("3화 그리고 12화", [rule({ find: "(\\d+)화", replace: "제$1화 [$&]", regex: true })]);
    expect(res.text).toBe("제3화 [3화] 그리고 제12화 [12화]");
  });

  it("reports an invalid regex instead of throwing and leaves the text alone", () => {
    const res = applyRules("본문", [rule({ id: "bad", find: "(", regex: true })]);
    expect(res.text).toBe("본문");
    expect(res.errors.bad).toBeTruthy();
  });

  it("skips disabled and empty rules, applies the rest in order", () => {
    const res = applyRules("abc", [
      rule({ id: "off", find: "a", replace: "Z", enabled: false }),
      rule({ id: "empty", find: "" }),
      rule({ id: "1", find: "b", replace: "c" }),
      rule({ id: "2", find: "cc", replace: "D" }),
    ]);
    expect(res.text).toBe("aD");
    expect(res.counts).toEqual({ "1": 1, "2": 1 });
  });
});

describe("reflow", () => {
  // A web-novel style text hard-wrapped every 20 characters mid-sentence.
  const sentence = "그는 천천히 낡은 서재의 문을 열고 먼지 쌓인 책장 사이로 걸어 들어갔다";
  const body = Array.from({ length: 12 }, () => sentence).join(" ") + ".";
  const wrapped = body.match(/.{1,20}/g)!.join("\n");

  it("does nothing when off", () => {
    const res = reflow(wrapped, "off");
    expect(res.text).toBe(wrapped);
    expect(res.stats.applied).toBe(false);
  });

  it("detects hard wrapping in auto mode and joins the lines", () => {
    const res = reflow(wrapped, "auto");
    expect(res.stats.applied).toBe(true);
    expect(res.stats.joined).toBeGreaterThan(10);
    expect(res.text.split("\n").length).toBeLessThan(wrapped.split("\n").length);
  });

  it("leaves normal prose (every line ends a sentence) alone in auto mode", () => {
    const prose = Array.from({ length: 30 }, (_, i) => `${i}번째 줄은 완결된 문장으로 끝나는 평범한 소설 문단입니다.`).join("\n");
    const res = reflow(prose, "auto");
    expect(res.stats.applied).toBe(false);
    expect(res.text).toBe(prose);
  });

  it("never joins into dialogue or chapter headings", () => {
    const lines = [...wrapped.split("\n"), "\"대사는 새 문단이다\"", "제 2화 다음 장"];
    const res = reflow(lines.join("\n"), "on");
    const out = res.text.split("\n");
    expect(out).toContain("\"대사는 새 문단이다\"");
    expect(out).toContain("제 2화 다음 장");
  });
});

describe("splitSentences", () => {
  it("splits on sentence punctuation with offsets into the paragraph", () => {
    const text = "첫 번째 문장입니다. 두 번째 문장이에요! 세 번째인가요?";
    const s = splitSentences(4, text);
    expect(s.map((x) => x.text)).toEqual(["첫 번째 문장입니다.", "두 번째 문장이에요!", "세 번째인가요?"]);
    for (const x of s) {
      expect(x.para).toBe(4);
      expect(text.slice(x.start, x.end)).toBe(x.text);
    }
  });

  it("merges very short pieces into the previous sentence", () => {
    const s = splitSentences(0, "아. 그렇게 된 일이었군요.");
    expect(s).toHaveLength(1);
  });

  it("cuts run-on sentences to the length limit", () => {
    const text = Array.from({ length: 40 }, () => "단어").join(" ");
    const s = splitSentences(0, text, 30);
    expect(s.length).toBeGreaterThan(1);
    for (const x of s) expect(x.text.length).toBeLessThanOrEqual(30);
  });

  it("drops pieces without letters or digits", () => {
    expect(splitSentences(0, "…… !!")).toEqual([]);
  });
});
