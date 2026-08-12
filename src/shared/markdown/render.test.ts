// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { fillMarkdown, renderMarkdown } from "./render";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

describe("shared Markdown renderer", () => {
  it("renders nested blockquotes and fenced code blocks", () => {
    const html = renderMarkdown("> outer\n>\n> > inner\n\n```ts\nconst x = 1;\n```");

    expect(html).toContain("<blockquote>");
    expect(html.match(/<blockquote>/g)).toHaveLength(2);
    expect(html).toContain('<code class="language-ts">const x = 1;');
  });

  it("renders inline and display math without interpreting code or escaped dollars", () => {
    const html = renderMarkdown([
      "Energy is $E=mc^2$.",
      "",
      "$$",
      "\\int_0^1 x^2 \\, dx",
      "$$",
      "",
      "`$not_math$` and \\$also_not_math$",
    ].join("\n"));

    expect(html).toContain('class="katex"');
    expect(html).toContain('class="katex-display"');
    expect(html).toContain("<code>$not_math$</code>");
    expect(html).toContain("$also_not_math$");
    expect(html.match(/class="katex"/g)).toHaveLength(2);
  });

  it("keeps incomplete and currency-like dollar text as text and safely exposes invalid TeX", () => {
    const html = renderMarkdown("Streaming $x^2 and prices $5 and $10. Invalid $\\notacommand{$.");

    expect(html).toContain("Streaming $x^2");
    expect(html).toContain("$5 and $10");
    expect(html).toContain('class="fn-math-error"');
    expect(html).not.toContain("<script");
  });

  it("renders GFM tables and read-only task lists", () => {
    const root = document.createElement("div");
    fillMarkdown(root, "| Name | Done |\n| --- | --- |\n| Item | yes |\n\n- [x] shipped\n- [ ] pending");

    expect(root.querySelector("table")?.textContent).toContain("Item");
    expect(root.querySelector("table")?.parentElement?.classList.contains("fn-markdown-table-scroll")).toBe(true);
    const tasks = [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(tasks).toHaveLength(2);
    expect(tasks.every((task) => task.disabled)).toBe(true);
    expect(tasks[0].checked).toBe(true);
  });

  it("opens external links through the guarded Tauri command", () => {
    const root = document.createElement("div");
    fillMarkdown(root, "[site](https://example.com)");
    const link = root.querySelector<HTMLAnchorElement>("a")!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });

    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(invoke).toHaveBeenCalledWith("open_url", { url: "https://example.com" });
  });

  it("escapes raw HTML and rejects unsafe links and images", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n[bad](javascript:alert(1)) ![track](https://example.com/pixel.png)');

    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    expect(html).toContain("track");
  });

  it("marks the shared root and falls back to plain text if rendering fails", () => {
    const root = document.createElement("div");
    fillMarkdown(root, "# title");

    expect(root.classList.contains("fn-markdown")).toBe(true);
    expect(root.querySelector("h1")?.textContent).toBe("title");
  });
});
