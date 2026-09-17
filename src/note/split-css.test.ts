import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
const noteAppSource = readFileSync(resolve(process.cwd(), "src/note/note-app.ts"), "utf8");
const editorCss = readFileSync(resolve(process.cwd(), "src/shared/markdown/structured-editor.css"), "utf8");
const editorSource = readFileSync(resolve(process.cwd(), "src/shared/markdown/structured-editor.ts"), "utf8");
const editorPlugins = readFileSync(resolve(process.cwd(), "src/shared/markdown/milkdown-plugins.ts"), "utf8");
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
    expect(noteAppSource).toContain('id="piece-editor-root" class="note-editor-host"');
    expect(css).toMatch(/\.note-editor-host\s*{[^}]*position:\s*relative;[^}]*min-height:\s*0;[^}]*flex:\s*1 1 auto;/s);
  });

  it("aligns the writing title with structured editor content", () => {
    expect(css).toMatch(/#piece-doc-header\s*{[^}]*padding-left:\s*var\(--piece-content-inset\);/s);
    expect(css).toMatch(
      /\.piece-title-input\s*{[^}]*font-size:\s*calc\(var\(--editor-font,\s*15px\)\s*\+\s*11px\);/s,
    );
    expect(editorCss).toMatch(
      /\.fn-note-structured-editor > \.editor\s*\{[^}]*padding:\s*var\(--fn-editor-top-space\) 0 var\(--fn-editor-bottom-space\);/s,
    );
    expect(editorSource).toContain("createStructuredMarkdownEditor");
    expect(pieceSwitcherSource).toContain('title.dataset.focusStyle = "quiet"');
    expect(css).toMatch(/\.piece-title-input:focus,[^{]*\.piece-title-input:focus-visible\s*\{[^}]*outline:\s*none;[^}]*box-shadow:\s*none;/s);
    expect(css).not.toContain(".cm-selected-line-break");
  });

  it("removes the Inbox block gutter and handle surface", () => {
    expect(editorCss).toMatch(/padding:\s*var\(--fn-editor-top-space\) 0 var\(--fn-editor-bottom-space\)/);
    expect(css).not.toContain(".cm-block-handle");
    expect(css).not.toContain(".cm-block-gutter");
    expect(noteAppSource).not.toContain("blockHandleGutter");
  });

  it("renders inline annotations without visible tag chips in body text", () => {
    expect(editorCss).toMatch(/\.fn-inline-annotation\s*{/s);
    expect(editorPlugins).toContain('aria-label": `已标注');
    expect(editorPlugins).toContain('excludes: ""');
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
    expect(noteAppSource).toMatch(/<div id="tag-bar-root"><\/div>[\s\S]*<div id="text-col" class="note-column">/);
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
    expect(noteAppSource).toMatch(/<div id="editor-root" class="note-scroll note-editor-host">\s*<div id="annotation-projection-root" hidden><\/div>\s*<\/div>/);
    expect(css).toMatch(/\.annotation-projection-item\s*{/s);
    expect(css).toMatch(/#annotation-projection-root\[hidden\]\s*{[^}]*display:\s*none;/s);
    expect(css).toMatch(/\.tag-readonly-hint\s*{[^}]*margin-left:\s*auto;/s);
  });

  it("fills empty structured editors and renders their ProseMirror-aware placeholders", () => {
    expect(editorCss).toMatch(/\.fn-structured-editor\s*{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
    expect(editorCss).toMatch(/\.fn-note-structured-editor\s*{[^}]*height:\s*auto;[^}]*min-height:\s*100%;/s);
    expect(editorCss).toMatch(/\.fn-note-structured-editor > \.editor\s*{[^}]*flex:\s*1 1 auto;/s);
    expect(editorCss).toMatch(/\.fn-structured-editor > \.editor > \.fn-empty-paragraph\s*{[^}]*position:\s*relative;/s);
    expect(editorCss).toMatch(
      /\.fn-structured-editor > \.editor > \.fn-empty-paragraph::before\s*{[^}]*position:\s*absolute;[^}]*top:\s*0;[^}]*inset-inline-start:\s*0;[^}]*line-height:\s*inherit;/s,
    );
    expect(editorSource).toContain('class: "fn-empty-paragraph"');
    expect(editorSource).toContain('options.parent.addEventListener("pointerdown", focusFromHostWhitespace)');
  });

  it("keeps the active writing line comfortable at both scroll edges", () => {
    expect(editorCss).toMatch(
      /\.fn-note-structured-editor\s*\{[^}]*--fn-editor-top-space:\s*24px;[^}]*--fn-editor-bottom-space:\s*max\(24px,\s*50vh\);/s,
    );
    expect(editorCss).toMatch(
      /\.fn-note-structured-editor > \.editor:has\(> :first-child > \.fn-structured-image:first-child\)\s*\{[^}]*--fn-editor-top-space:\s*52px;/s,
    );
    expect(editorCss).toMatch(
      /\.fn-structured-image__tools\s*\{[^}]*bottom:\s*calc\(100% \+ 8px\);/s,
    );
    expect(editorCss).toMatch(
      /\.fn-structured-image\s*\{[^}]*max-width:\s*calc\(100% - 8px\);[^}]*margin-inline:\s*4px;/s,
    );
  });

  it("uses one note body surface instead of inbox and piece style forks", () => {
    expect(editorSource).toContain('noteSurface ? "fn-note-structured-editor" : ""');
    expect(editorSource).toContain("ctx.set(rootAttrsCtx");
    expect(noteAppSource).not.toContain("fn-piece-structured-editor");
    expect(noteAppSource).not.toContain("fn-inbox-structured-editor");
    expect(editorCss).not.toContain(".fn-inbox-structured-editor");
    expect(editorCss).not.toContain(".fn-piece-structured-editor");
    expect(editorCss).toMatch(/\.fn-structured-editor\s*{[^}]*font-family:\s*var\(--font-sans\);/s);
  });

  it("shows list disclosure controls only for items that actually contain a nested list", () => {
    expect(editorCss).toMatch(/\.fn-structured-editor \.fn-list-fold-toggle\[hidden\]\s*{[^}]*display:\s*none;/s);
  });

  it("reserves separate list gutters for disclosure controls and multi-digit markers", () => {
    expect(editorCss).toMatch(
      /\.fn-structured-editor ol,\s*\.fn-structured-editor ul\s*\{[^}]*--fn-list-indent:\s*3\.2em;[^}]*padding-inline-start:\s*var\(--fn-list-indent\);/s,
    );
    expect(editorCss).toMatch(
      /\.fn-structured-editor \.fn-list-fold-toggle\s*\{[^}]*inset-inline-start:\s*calc\(-1 \* var\(--fn-list-indent\) \+ 0\.3em\);/s,
    );
    expect(editorCss).toMatch(
      /\.fn-structured-editor li > \.fn-list-item-content > ol,\s*\.fn-structured-editor li > \.fn-list-item-content > ul\s*\{[^}]*margin-inline-start:\s*-1em;/s,
    );
  });

  it("keeps dividers and blockquotes on semantic theme colors", () => {
    expect(editorCss).toMatch(/\.fn-structured-divider hr\s*{[^}]*height:\s*1px;[^}]*background:\s*var\(--color-divider\);/s);
    expect(editorCss).toMatch(/\.fn-structured-editor blockquote\s*{[^}]*border-left:[^}]*var\(--color-border-strong\);[^}]*background:/s);
  });

  it("keeps special-block selection thin, contained and consistently rounded", () => {
    expect(editorCss).toMatch(/\.fn-structured-editor \.ProseMirror-selectednode[^}]*outline:\s*1px solid[^}]*outline-offset:\s*-1px;/s);
    expect(editorCss).toMatch(/\.fn-structured-editor blockquote\s*{[^}]*border-radius:\s*6px;/s);
    expect(editorCss).toMatch(/\.fn-structured-editor \.fn-quote-card\s*{[^}]*border-radius:\s*8px;/s);
    expect(editorCss).toMatch(/\.fn-structured-divider\s*{[^}]*min-height:\s*16px;/s);
  });

  it("keeps inline field carets native and gives the code-language caret enough height", () => {
    expect(editorCss).toMatch(/\.fn-quote-card__source-input:focus-visible\s*{[^}]*outline:\s*none;[^}]*box-shadow:\s*none;/s);
    expect(editorCss).toMatch(/\.fn-quote-card__source-input:focus-visible\s*{[^}]*caret-color:\s*auto;/s);
    expect(editorCss).toMatch(/\.fn-structured-codeblock__language\s*{[^}]*height:\s*20px;[^}]*padding:\s*2px 0;[^}]*border-radius:\s*0;[^}]*font:\s*0\.8em\/16px[^}]*caret-color:\s*auto;/s);
    expect(editorCss).toMatch(/\.fn-structured-codeblock__language:focus-visible\s*{[^}]*outline:\s*none;[^}]*box-shadow:\s*none;[^}]*caret-color:\s*auto;/s);
    expect(editorCss).not.toMatch(/caret-color:\s*var\(--color-accent\)/);
  });

  it("shares column, scrollport and area-bar layout rules", () => {
    expect(noteAppSource).toContain('id="text-col" class="note-column"');
    expect(noteAppSource).toContain('id="piece-col" class="note-column"');
    expect(noteAppSource).toContain('id="editor-root" class="note-scroll note-editor-host"');
    expect(noteAppSource).toContain('id="piece-scroll" class="note-scroll"');
    expect(css).toMatch(/\.note-scroll\s*{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;[^}]*background:\s*var\(--color-surface\);/s);
    expect(css).toMatch(/#piece-topbar-root,\s*\.tag-bar\s*{[^}]*padding:\s*6px 14px;[^}]*border-bottom:\s*1px solid var\(--color-divider\);/s);
  });

  // 头部（标题栏 + 顶栏）必须固定：文档层不得成为滚动视口，内层滚动也不得链式
  // 传播到 body，否则整个应用外壳会随正文一起上下滑动。
  it("pins the app shell so the chrome never scrolls with the content", () => {
    expect(css).toMatch(/html,\s*body\s*{[^}]*overflow:\s*hidden;[^}]*overscroll-behavior:\s*none;/s);
    expect(css).toMatch(/#app\s*{[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/#titlebar-root,\s*#topbar-root\s*{[^}]*flex:\s*0 0 auto;/s);
    expect(css).toMatch(/\.note-scroll\s*{[^}]*overscroll-behavior:\s*contain;/s);
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
