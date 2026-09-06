import { describe, it, expect } from "vitest";
import { emptyStateMarkup } from "./empty-state";

describe("emptyStateMarkup", () => {
  it("renders title, hint, and both buttons", () => {
    const html = emptyStateMarkup({
      icon: "✍️",
      title: "欢迎来到 FloatNote",
      hint: "还没有项目空间。",
      primary: { label: "新建项目", action: () => {} },
      secondary: { label: "新建文档", action: () => {} },
    });
    expect(html).toContain('class="fn-empty__icon"');
    expect(html).toContain(">✍️<");
    expect(html).toContain('class="fn-empty__title"');
    expect(html).toContain("欢迎来到 FloatNote");
    expect(html).toContain('class="fn-empty__hint"');
    expect(html).toContain("还没有项目空间。");
    expect(html).toContain('data-action="primary"');
    expect(html).toContain("新建项目");
    expect(html).toContain('data-action="secondary"');
    expect(html).toContain("新建文档");
  });

  it("omits icon, hint, and actions when not provided", () => {
    const html = emptyStateMarkup({ title: "仅标题" });
    expect(html).not.toContain("fn-empty__icon");
    expect(html).not.toContain("fn-empty__hint");
    expect(html).not.toContain("fn-empty__actions");
    expect(html).toContain("仅标题");
  });

  it("renders only a primary button when secondary is absent", () => {
    const html = emptyStateMarkup({
      title: "无作品",
      primary: { label: "新建作品", action: () => {} },
    });
    expect(html).toContain('data-action="primary"');
    expect(html).not.toContain('data-action="secondary"');
  });

  it("HTML-escapes user-supplied hint text to prevent injection", () => {
    const html = emptyStateMarkup({
      title: "x",
      hint: '<script>alert(1)</script> & "项目"',
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;");
  });

  it("escapes the title too", () => {
    const html = emptyStateMarkup({ title: '<b>bold</b>' });
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>bold</b>");
  });
});
