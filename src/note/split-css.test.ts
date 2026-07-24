import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
const noteAppSource = readFileSync(resolve(process.cwd(), "src/note/note-app.ts"), "utf8");
const editorSource = readFileSync(resolve(process.cwd(), "src/note/editor.ts"), "utf8");
const annotationDecorationSource = readFileSync(resolve(process.cwd(), "src/note/annotations/decoration.ts"), "utf8");
const pieceSwitcherSource = readFileSync(resolve(process.cwd(), "src/note/piece-switcher.ts"), "utf8");
const assistantCss = readFileSync(resolve(process.cwd(), "src/assistant/styles.css"), "utf8");
const semanticCss = readFileSync(resolve(process.cwd(), "src/styles/semantic.css"), "utf8");
const assistantBubbleColor = semanticCss.match(/--color-bubble-ai-bg:\s*(#[0-9a-fA-F]{6});/s)?.[1];

describe("split view CSS placement", () => {
  it("pins both editor columns below the tag bar row in split mode", () => {
    expect(css).toMatch(
      /#app\.split-active\s+#text-col\s*{[^}]*grid-column:\s*2;[^}]*grid-row:\s*2;/s,
    );
    expect(css).toMatch(
      /#app\.split-active\s+#piece-col\s*{[^}]*grid-column:\s*4;[^}]*grid-row:\s*2;/s,
    );
  });

  // layout-controller 把 --piece / --split-gap 写到 #app 上。这两个变量的默认值必须
  // 也定义在 #app（而非 #note-body），否则 #note-body 的本地声明会遮蔽来自 #app 的值，
  // 使 var(--piece) 恒为 0、双栏写作栏宽度塌成 0（不可见、不可编辑）。
  it("declares split grid vars on #app, not shadowed by #note-body", () => {
    const appBody = css.match(/#app\s*{([^}]*)}/s)?.[1] ?? "";
    const noteBodyBody = css.match(/#note-body\s*{([^}]*)}/s)?.[1] ?? "";
    expect(appBody).toMatch(/--piece:/);
    expect(appBody).toMatch(/--split-gap:/);
    expect(noteBodyBody).not.toMatch(/--piece:/);
    expect(noteBodyBody).not.toMatch(/--split-gap:/);
  });

  it("lets the piece editor fill the writing column", () => {
    expect(css).toMatch(
      /#piece-scroll\s*{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*flex:\s*1 1 auto;/s,
    );
    expect(css).toMatch(
      /#piece-editor-root\s*{[^}]*position:\s*relative;[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;/s,
    );
  });

  it("aligns the writing title with editor content and leaves selection rendering to CodeMirror", () => {
    expect(css).toMatch(/#piece-doc-header\s*{[^}]*padding-left:\s*var\(--piece-content-inset\);/s);
    expect(css).toMatch(
      /\.piece-title-input\s*{[^}]*font-size:\s*calc\(var\(--editor-font,\s*15px\)\s*\+\s*11px\);/s,
    );
    expect(editorSource).toContain('padding: "16px var(--piece-content-inset, 0px)"');
    expect(editorSource).toContain("drawSelection({ cursorBlinkRate: 1200 })");
    expect(css).not.toContain(".cm-selected-line-break");
  });

  it("removes the Inbox block gutter and handle surface", () => {
    expect(editorSource).toMatch(/padding:\s*"16px 0"/);
    expect(css).not.toContain(".cm-block-handle");
    expect(css).not.toContain(".cm-block-gutter");
    expect(noteAppSource).not.toContain("blockHandleGutter");
  });

  it("renders inline annotations without visible tag chips in body text", () => {
    expect(css).toMatch(/\.cm-inline-annotation\s*{/s);
    expect(annotationDecorationSource).toContain("background-image");
    expect(annotationDecorationSource).toContain("aria-label");
    expect(annotationDecorationSource).not.toContain("title:");
  });

  it("expands top tag discs into label chips on hover or active state without a selection ring", () => {
    const row = css.match(/\.tag-disc-row\s*{([^}]*)}/s)?.[1] ?? "";
    const disc = css.match(/\.tag-filter-disc\s*{([^}]*)}/s)?.[1] ?? "";
    const name = css.match(/\.tag-filter-name\s*{([^}]*)}/s)?.[1] ?? "";
    expect(row).toMatch(/gap:\s*5px;/);
    expect(row).toMatch(/overflow-x:\s*auto;/);
    expect(disc).toMatch(/display:\s*inline-flex;/);
    expect(disc).toMatch(/width:\s*auto;/);
    expect(name).toMatch(/max-width:\s*0;/);
    expect(css).toMatch(/\.tag-filter-disc:is\(:hover,\s*\.active\)\s+\.tag-filter-name\s*{[^}]*max-width:\s*120px;/s);
    expect(css).not.toMatch(/\.tag-filter-disc(?:\:hover|,\s*\.tag-filter-disc\.active)?\s*{[^}]*box-shadow:\s*0 0 0 2px/s);
  });

  it("lets the tag control bar span the full note body instead of the centered text column", () => {
    const tagBar = css.match(/\.tag-bar\s*{([^}]*)}/s)?.[1] ?? "";
    expect(noteAppSource).toMatch(/<div id="tag-bar-root"><\/div>[\s\S]*<div id="text-col">/);
    expect(noteAppSource).toMatch(/#tag-bar-root/);
    expect(tagBar).not.toMatch(/margin-left:\s*calc\(-1 \* var\(--left\)\);/);
    expect(tagBar).not.toMatch(/width:\s*calc\(100% \+ var\(--left\) \+ var\(--right\)\);/);
    expect(css).toMatch(
      /#tag-bar-root\s*{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*grid-row:\s*1;[^}]*display:\s*flex;/s,
    );
    expect(css).toMatch(/#text-col\s*{[^}]*grid-row:\s*2;/s);
  });

  it("renders filtered results in a separate read-only segmented projection", () => {
    expect(noteAppSource).toContain('id="annotation-projection-root"');
    expect(css).toMatch(/\.annotation-projection-item\s*{/s);
    expect(css).toMatch(/#annotation-projection-root\[hidden\]\s*{[^}]*display:\s*none;/s);
    expect(css).toMatch(/\.tag-readonly-hint\s*{[^}]*margin-left:\s*auto;/s);
  });

  it("gives the floating assistant a soft background without bubble borders", () => {
    // 浮层卡片：磨砂半透背景 + 阴影，无边框（气泡自身有底，卡片不重复边框）。
    expect(css).toMatch(
      /#app\.mode-floating\s+#assistant-region\s+\.assistant-card\s*{[^}]*background:\s*var\(--color-overlay\);[^}]*backdrop-filter:\s*blur\([^}]+;[^}]*box-shadow:/s,
    );
    expect(css).not.toMatch(
      /#app\.mode-floating\s+#assistant-region\s+\.assistant-card::before\s*{/,
    );
    // AI 气泡底色走语义 token（light/dark 由 semantic.css 统一切换），
    // assistant 窗口不再保留 per-window dark @media 块。
    expect(assistantCss).toMatch(
      /\.chat-block-text\s*>\s*\.chat-text-content\s*{[^}]*background:\s*var\(--color-bubble-ai-bg\);/s,
    );
    expect(assistantBubbleColor).toBe("#f3f1ec");
    expect(assistantCss).not.toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/s);
  });

  it("renders streaming with a caret (::after) instead of cancelling entrance animation", () => {
    // 新机制：增量渲染复用块节点（见 blocks.test.ts），不再用 `animation: none`
    // 抑制流式气泡的进场动画；流式指示改为 caret ::after。
    expect(assistantCss).toMatch(/\.chat-compact-cursor,[^{]*\.chat-compact-progress\s*{/s);
    expect(assistantCss).not.toMatch(/\.chat-block-text\.chat-streaming::after\s*{/s);
    expect(assistantCss).not.toMatch(/\.chat-streaming\s*\{[^}]*animation:\s*none/s);
  });
});

describe("per-area topbars (采集 / 写作)", () => {
  // 双栏下采集顶栏必须收缩到采集列（col 2），不再横跨写作列；单栏仍满边距。
  it("scopes the collection tag bar to the inbox column in split mode", () => {
    expect(css).toMatch(/#app\.split-active\s+#tag-bar-root\s*\{[^}]*grid-column:\s*2;/s);
  });

  it("gives the writing area its own fixed topbar, hidden by default", () => {
    expect(noteAppSource).toMatch(/<div id="piece-topbar-root"><\/div>/);
    expect(css).toMatch(/#piece-topbar-root\s*\{[^}]*grid-row:\s*1;[^}]*display:\s*none;/s);
  });

  it("spans the writing topbar full width in single-piece mode, scoped to col 4 in split", () => {
    expect(css).toMatch(
      /#app\.show-piece:not\(\.split-active\)\s+#piece-topbar-root\s*\{[^}]*display:\s*flex;[^}]*grid-column:\s*1\s*\/\s*-1;/s,
    );
    expect(css).toMatch(
      /#app\.split-active\s+#piece-topbar-root\s*\{[^}]*display:\s*flex;[^}]*grid-column:\s*4;/s,
    );
  });

  it("removes the empty writing control bar and its reserved row in document mode", () => {
    expect(css).toMatch(
      /#app\.doc-mode\s+#piece-topbar-root\s*\{[^}]*display:\s*none\s*!important;/s,
    );
    expect(css).toMatch(
      /#app\.doc-mode\s+#piece-col\s*\{[^}]*grid-row:\s*1;/s,
    );
  });

  it("splits createPieceHeader across the topbar mount and the title mount", () => {
    expect(noteAppSource).toMatch(/createPieceHeader\(\{[^}]*topbarMount/);
    expect(pieceSwitcherSource).toMatch(/topbarMount\.appendChild\(crumbRow\)/);
    expect(pieceSwitcherSource).toMatch(/titleMount\.appendChild\(title\)/);
  });
});
