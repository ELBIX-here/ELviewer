// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { htmlToDoc } from "./html";

const paras = (html: string) => htmlToDoc(html).text.split("\n");
const styled = (html: string, para: number) =>
  (htmlToDoc(html).styles.get(para) ?? []).map((d) => [htmlToDoc(html).text.split("\n")[para].slice(d.start, d.end), d.cls]);

describe("htmlToDoc", () => {
  it("makes paragraphs from blocks and line breaks, collapsing whitespace", () => {
    expect(paras("<p>첫  문단\n  이어짐</p><div>둘째</div>셋째<br>넷째")).toEqual(["첫 문단 이어짐", "둘째", "셋째", "넷째"]);
  });

  it("skips head, scripts, styles and ruby readings", () => {
    const doc = htmlToDoc("<html><head><title>T</title><style>p{}</style></head><body><script>var unused = 1</script><p><ruby>漢<rt>かん</rt></ruby>字</p></body></html>");
    expect(doc.text).toBe("漢字");
  });

  it("turns headings into styled paragraphs and a table of contents", () => {
    const doc = htmlToDoc("<h1>프롤로그</h1><p>본문</p><h2>1화 <em>시작</em></h2><p>본문</p>");
    expect(doc.toc).toEqual([
      { label: "프롤로그", para: 0, level: 0 },
      { label: "1화 시작", para: 2, level: 1 },
    ]);
    expect(doc.styles.get(2)?.[0]).toMatchObject({ start: 0, end: 5, cls: "md-h md-h2" });
  });

  it("leaves a single heading to the chapter detector", () => {
    expect(htmlToDoc("<h1>제목</h1><p>본문</p>").toc).toEqual([]);
  });

  it("keeps inline styles, also across a line break", () => {
    expect(styled("<p>아주 <b>굵고 <i>기운</i></b> 글</p>", 0)).toEqual([
      ["기운", "md-i"],
      ["굵고 기운", "md-b"],
    ]);
    const html = "<p><strong>한 줄<br>두 줄</strong></p>";
    expect(paras(html)).toEqual(["한 줄", "두 줄"]);
    expect(styled(html, 0)).toEqual([["한 줄", "md-b"]]);
    expect(styled(html, 1)).toEqual([["두 줄", "md-b"]]);
  });

  it("writes list bullets, numbers and nesting", () => {
    expect(paras('<ul><li>가<ul><li>나</li></ul></li></ul><ol start="3"><li><p>다</p></li><li>라</li></ol>')).toEqual(["• 가", "　• 나", "3. 다", "4. 라"]);
  });

  it("handles quotes, rules, images, tables and preformatted text", () => {
    const doc = htmlToDoc('<blockquote><p>인용</p></blockquote><hr><p><img alt="지도"> 아래</p><table><tr><th>이름</th><td>값</td></tr></table><pre>a  b\n\nc</pre>');
    expect(doc.text.split("\n")).toEqual(["인용", "* * *", "[그림: 지도] 아래", "이름  ·  값", "a  b", "c"]);
    expect(doc.styles.get(0)?.[0].cls).toBe("md-quote");
    expect(doc.styles.get(3)?.[0].cls).toBe("md-table");
    expect(doc.styles.get(4)?.[0].cls).toBe("md-code md-pre");
  });
});
