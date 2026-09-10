// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
import { createStructuredMarkdownEditor, type StructuredMarkdownEditor } from "./structured-editor";

if (!Range.prototype.getClientRects) {
  Object.defineProperty(Range.prototype, "getClientRects", { value: () => [] });
}

describe("structured markdown editor", () => {
  let editor: StructuredMarkdownEditor | undefined;

  afterEach(async () => {
    await editor?.destroy();
    document.body.replaceChildren();
  });

  it("round-trips structural lists and math", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = await createStructuredMarkdownEditor({
      parent,
      context: { kind: "piece" },
      markdown: "1. first\n2. second\n\nafter $x^2$\n\n$$\ny = 2\n$$",
    });

    expect(parent.querySelector("ol")?.querySelectorAll("li")).toHaveLength(2);
    expect(parent.querySelector(".fn-structured-math--inline")).toBeTruthy();
    expect(parent.querySelector(".fn-structured-math--block")).toBeTruthy();
    expect(editor.getMarkdown()).toContain("1. first");
    expect(editor.getMarkdown()).toContain("$x^2$");
  });

  it("keeps preview replacement out of undo history when requested", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = await createStructuredMarkdownEditor({
      parent,
      context: { kind: "piece" },
      markdown: "current",
    });
    const checkpoint = editor.checkpoint();
    editor.replace("preview", { addToHistory: false });
    expect(editor.getMarkdown().trim()).toBe("preview");
    editor.restore(checkpoint);
    expect(editor.getMarkdown().trim()).toBe("current");
  });

  it("assigns the same note surface to inbox, piece and document editors only", async () => {
    const editors: StructuredMarkdownEditor[] = [];
    try {
      for (const kind of ["inbox", "piece", "document", "composer"] as const) {
        const parent = document.createElement("div");
        document.body.append(parent);
        const current = await createStructuredMarkdownEditor({ parent, context: { kind } });
        editors.push(current);
        expect(current.element.classList.contains("fn-note-structured-editor")).toBe(kind !== "composer");
      }
      expect(document.querySelector(".fn-inbox-structured-editor")).toBeNull();
      expect(document.querySelector(".fn-piece-structured-editor")).toBeNull();
    } finally {
      await Promise.all(editors.map((current) => current.destroy()));
    }
  });

  it("preserves root classes and the live element reference after a document load", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = await createStructuredMarkdownEditor({
      parent,
      context: { kind: "inbox" },
      placeholder: "写点什么…",
    });
    const initialRoot = editor.element;

    editor.load("loaded");

    expect(editor.element).not.toBe(initialRoot);
    expect(editor.element.isConnected).toBe(true);
    expect(editor.element.className).toContain("fn-structured-editor");
    expect(editor.element.className).toContain("fn-note-structured-editor");
    expect(editor.element.dataset.placeholder).toBe("写点什么…");
  });

  it("renders the placeholder on the live empty paragraph", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = await createStructuredMarkdownEditor({
      parent,
      context: { kind: "piece" },
      placeholder: "开始写…",
    });

    const initialParagraph = editor.contentDOM.querySelector(":scope > p:only-child");
    expect(initialParagraph?.classList.contains("fn-empty-paragraph")).toBe(true);
    expect(initialParagraph?.getAttribute("data-placeholder")).toBe("开始写…");

    editor.replace("正文");
    expect(editor.contentDOM.querySelector(".fn-empty-paragraph")).toBeNull();

    editor.replace("");
    const replacementParagraph = editor.contentDOM.querySelector(":scope > p:only-child");
    expect(replacementParagraph?.classList.contains("fn-empty-paragraph")).toBe(true);
    expect(replacementParagraph?.getAttribute("data-placeholder")).toBe("开始写…");
  });

  it("focuses a note editor at its logical end when host whitespace is pressed", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = await createStructuredMarkdownEditor({
      parent,
      context: { kind: "inbox" },
      markdown: "first\n\nsecond",
    });
    editor.contentDOM.blur();
    parent.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(document.activeElement).toBe(editor.contentDOM);
    editor.withView((view) => {
      expect(view.state.selection.to).toBe(view.state.doc.content.size - 1);
    });
  });

  it("focuses the live empty surface after loading a new document", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = await createStructuredMarkdownEditor({ parent, context: { kind: "inbox" } });

    editor.load("");
    const liveRoot = editor.element;
    liveRoot.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));

    expect(liveRoot.isConnected).toBe(true);
    expect(document.activeElement).toBe(editor.contentDOM);
    editor.withView((view) => expect(view.state.selection.from).toBe(1));
  });

  it("does not focus hidden or read-only note editors from host whitespace", async () => {
    const parent = document.createElement("div");
    const outside = document.createElement("button");
    document.body.append(parent, outside);
    editor = await createStructuredMarkdownEditor({ parent, context: { kind: "inbox" } });

    outside.focus();
    editor.element.hidden = true;
    parent.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(document.activeElement).toBe(outside);

    editor.element.hidden = false;
    editor.setReadOnly(true);
    parent.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(document.activeElement).toBe(outside);
  });

  it("folds a nested list through mapped ProseMirror decoration state", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = await createStructuredMarkdownEditor({
      parent,
      context: { kind: "piece" },
      markdown: "- parent\n  - child",
    });
    const toggle = parent.querySelector<HTMLButtonElement>(".fn-list-fold-toggle:not([hidden])");
    expect(toggle).toBeTruthy();
    toggle!.click();
    expect(toggle!.closest("li")?.classList.contains("fn-list-item--folded")).toBe(true);
    expect(editor.getMarkdown()).toContain("child");
  });

  it("edits GFM task items through a structural checkbox", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = await createStructuredMarkdownEditor({
      parent,
      context: { kind: "piece" },
      markdown: "- [ ] unfinished",
    });
    const checkbox = parent.querySelector<HTMLInputElement>(".fn-task-list-checkbox");
    expect(checkbox?.checked).toBe(false);
    checkbox!.checked = true;
    checkbox!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(editor.getMarkdown()).toMatch(/[*-] \[x\] unfinished/);
  });

  it("loads FloatNote quote callouts as dedicated structural cards", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = await createStructuredMarkdownEditor({
      parent,
      context: { kind: "inbox" },
      markdown: "> [!quote] Terminal\n> captured text",
    });
    expect(parent.querySelector("[data-fn-quote-card]")?.textContent).toContain("captured text");
    expect(editor.getMarkdown()).toContain("> [!quote] Terminal");
  });

  it("selects and deletes a quote card from its header even when it is the first block", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = await createStructuredMarkdownEditor({
      parent,
      context: { kind: "inbox" },
      markdown: "> [!quote] Terminal\n> captured text",
    });
    parent.querySelector<HTMLElement>(".fn-quote-card__source")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    editor.withView((view) => expect(view.state.selection.constructor.name).toBe("NodeSelection"));
    expect(parent.querySelector(".fn-quote-card")?.classList.contains("is-block-selected")).toBe(true);
    editor.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(editor.getMarkdown()).not.toContain("[!quote]");
  });

  it("opens quote sources independently of block selection and explicitly edits details", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = await createStructuredMarkdownEditor({
      parent,
      context: { kind: "inbox" },
      markdown: "> [!quote] [Browser](https://example.com)\n> captured text",
    });
    const initialSource = parent.querySelector<HTMLAnchorElement>(".fn-quote-card__source a")!;
    initialSource.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    initialSource.click();
    editor.withView((view) => expect(view.state.selection.constructor.name).not.toBe("NodeSelection"));
    parent.querySelector<HTMLElement>(".fn-quote-card__header")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    const label = parent.querySelector<HTMLInputElement>('[aria-label="引用来源名称"]')!;
    const url = parent.querySelector<HTMLInputElement>('[aria-label="引用来源链接"]')!;
    const sourceEditor = parent.querySelector<HTMLElement>(".fn-quote-card__source-editor")!;
    expect(sourceEditor.hidden).toBe(true);
    const anchor = parent.querySelector<HTMLAnchorElement>(".fn-quote-card__source a")!;
    anchor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    anchor.click();
    expect(invoke).toHaveBeenCalledWith("open_url", { url: "https://example.com" });
    expect(sourceEditor.hidden).toBe(true);
    const edit = parent.querySelector<HTMLButtonElement>('[aria-label="编辑引用来源"]')!;
    edit.click();
    expect(sourceEditor.hidden).toBe(false);
    label.value = "Discard";
    url.value = "https://discard.example.com";
    label.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(sourceEditor.hidden).toBe(true);
    expect(editor.getMarkdown()).toContain("[Browser](https://example.com)");
    edit.click();
    expect(label.value).toBe("Browser");
    label.value = "Docs";
    url.value = "https://docs.example.com";
    label.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(editor.getMarkdown()).toContain("[Docs](https://docs.example.com)");
    expect(sourceEditor.hidden).toBe(true);
    parent.querySelector<HTMLAnchorElement>(".fn-quote-card__source a")!.click();
    expect(invoke).toHaveBeenLastCalledWith("open_url", { url: "https://docs.example.com" });
    expect(editor.getMarkdown()).toContain("captured text");
    expect(parent.querySelector(".fn-quote-card__content")?.textContent).toContain("captured text");
    edit.click();
    parent.querySelector<HTMLButtonElement>('[aria-label="移除引用来源"]')!.click();
    parent.querySelector<HTMLButtonElement>('[aria-label="保存引用来源"]')!.click();
    expect(editor.getMarkdown()).toContain("> [!quote]");
    expect(editor.getMarkdown()).not.toContain("docs.example.com");
    expect(editor.getMarkdown()).toContain("captured text");
  });

  it.each([
    ["blockquote", "> first block", ".fn-structured-block-handle"],
    ["code block", "```ts\nconst value = 1;\n```", ".fn-structured-codeblock .fn-structured-block-handle"],
    ["divider", "---", ".fn-structured-divider"],
  ])("selects and deletes a first-position %s as one block", async (_name, markdown, selector) => {
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = await createStructuredMarkdownEditor({ parent, context: { kind: "piece" }, markdown });
    parent.querySelector<HTMLElement>(selector)!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    editor.withView((view) => expect(view.state.selection.constructor.name).toBe("NodeSelection"));
    editor.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    expect(editor.getMarkdown()).not.toContain(markdown.includes("first") ? "first" : markdown.includes("const") ? "const value" : "---");
  });

  it("turns the slash quote shortcut into a native blockquote", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = await createStructuredMarkdownEditor({ parent, context: { kind: "piece" } });
    editor.withView((view) => {
      view.dispatch(view.state.tr.insertText("/quote", 1));
      const position = view.state.selection.from;
      view.someProp("handleTextInput", (handler) => handler(
        view,
        position,
        position,
        " ",
        () => view.state.tr.insertText(" ", position, position),
      ));
    });
    expect(parent.querySelector("blockquote")).toBeTruthy();
    expect(editor.getMarkdown()).toMatch(/^> /m);
  });

  it("preserves image attributes and reveals compact tools only after selection", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = await createStructuredMarkdownEditor({
      parent,
      context: { kind: "piece", resolveImageSrc: (url) => `resolved:${url}` },
      markdown: "![caption](_assets/a.png){width=320}",
    });
    const figure = parent.querySelector<HTMLElement>(".fn-structured-image")!;
    const image = parent.querySelector<HTMLImageElement>(".fn-structured-image__image")!;
    expect(image.src).toContain("resolved:_assets/a.png");
    expect(editor.getMarkdown()).toContain("{width=320}");
    expect(parent.querySelector(".fn-structured-image__width")).toBeNull();
    expect(figure.classList.contains("is-selected")).toBe(false);
    image.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(figure.classList.contains("is-selected")).toBe(true);
    parent.querySelector<HTMLButtonElement>('[data-align="center"]')!.click();
    expect(editor.getMarkdown()).toContain("{width=320 .center}");
  });

  it("maps structural caret positions into canonical Markdown without falling back to the end", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = await createStructuredMarkdownEditor({
      parent,
      context: { kind: "inbox" },
      markdown: "first **bold**\n\nsecond",
    });
    let insideBold = 0;
    editor.withView((view) => {
      view.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === "bold") insideBold = pos + 2;
      });
    });
    expect(editor.markdownOffsetAt(insideBold)).toBe("first **bo".length);
    expect(editor.markdownOffsetAt(insideBold)).toBeLessThan(editor.getMarkdown().indexOf("second"));
  });

  it("round-trips the structural golden corpus without losing semantic content", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const markdown = [
      "3. parent",
      "   - child $x$",
      "",
      "after list",
      "",
      "> quote",
      "",
      "| A | B |",
      "| :- | -: |",
      "| 中 | 文 |",
      "",
      "```ts",
      "const value = 1;",
      "```",
    ].join("\r\n");
    editor = await createStructuredMarkdownEditor({ parent, context: { kind: "document" }, markdown });
    const output = editor.getMarkdown();
    expect(parent.querySelector("ol")?.start).toBe(3);
    for (const content of ["parent", "child", "after list", "quote", "中", "const value = 1;"]) {
      expect(output).toContain(content);
    }
    expect(output).toContain("$x$");
    expect(output).toContain("| A");
  });

  it("uses ProseMirror list transactions for Enter instead of rewriting line numbers", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = await createStructuredMarkdownEditor({ parent, context: { kind: "piece" }, markdown: "7. item" });
    editor.withView((view) => {
      let end = 1;
      view.state.doc.descendants((node, pos) => { if (node.isText) end = pos + node.nodeSize; });
      editor!.setSelection(end);
    });
    editor.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(parent.querySelectorAll("ol > li")).toHaveLength(2);
    expect(parent.querySelector("ol")?.start).toBe(7);
  });

  it("never mounts raw HTML or unsafe link destinations", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = await createStructuredMarkdownEditor({
      parent,
      context: { kind: "document" },
      markdown: '<img src=x onerror="alert(1)">\n\n[bad](javascript:alert(1))',
    });
    expect(parent.querySelector("img[onerror]")).toBeNull();
    expect(parent.querySelector<HTMLAnchorElement>("a")?.getAttribute("href") ?? "").not.toContain("javascript:");
  });

});
