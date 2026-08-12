import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("escapes raw text into a paragraph", () => {
    expect(renderMarkdown("hello & <world>")).toBe(
      `<p>hello &amp; &lt;world&gt;</p>`,
    );
  });

  it("renders bold and inline code via renderInline", () => {
    expect(renderMarkdown("**a** and `b`")).toBe(
      `<p><strong>a</strong> and <code>b</code></p>`,
    );
  });

  it("renders a safe https link and drops javascript: links", () => {
    const out = renderMarkdown("[ok](https://ex.com) [bad](javascript:alert(1))");
    expect(out).toContain(`<a href="https://ex.com">ok</a>`);
    expect(out).toContain("bad");
    expect(out).not.toContain("javascript:");
  });

  it("renders headings h1..h3", () => {
    expect(renderMarkdown("# T1\n## T2\n### T3")).toBe(
      `<h1>T1</h1><h2>T2</h2><h3>T3</h3>`,
    );
  });

  it("renders unordered and ordered lists", () => {
    expect(renderMarkdown("- a\n- b")).toBe(`<ul><li>a</li><li>b</li></ul>`);
    expect(renderMarkdown("1. a\n2. b")).toBe(`<ol><li>a</li><li>b</li></ol>`);
  });

  it("renders a fenced code block with escaped content (no highlight)", () => {
    const out = renderMarkdown("```js\nconst a = \"<b>\";\n```");
    expect(out).toBe(
      `<pre class="chat-codeblock"><code class="language-js">const a = &quot;&lt;b&gt;&quot;;</code></pre>`,
    );
  });

  it("escapes a code block that tries to break out of <code>", () => {
    const out = renderMarkdown("```\n</code><script>x</script>\n```");
    expect(out).toContain("&lt;/code&gt;");
    expect(out).not.toContain("</code><script>");
  });

  it("mixes prose and code blocks", () => {
    const out = renderMarkdown("before\n\n```js\nx\n```\nafter");
    expect(out).toContain(`<p>before</p>`);
    expect(out).toContain(`<pre class="chat-codeblock">`);
    expect(out).toContain(`<p>after</p>`);
  });

  it("renders blockquote", () => {
    expect(renderMarkdown("> quoted")).toBe(`<blockquote><p>quoted</p></blockquote>`);
  });

  it("renders three hyphens as a horizontal rule", () => {
    expect(renderMarkdown("before\n\n---\n\nafter")).toBe(`<p>before</p><hr><p>after</p>`);
  });

  it("merges consecutive non-empty lines into one paragraph", () => {
    expect(renderMarkdown("line one\nline two")).toBe(`<p>line one line two</p>`);
  });

  it("returns empty string for empty input", () => {
    expect(renderMarkdown("")).toBe("");
  });
});
