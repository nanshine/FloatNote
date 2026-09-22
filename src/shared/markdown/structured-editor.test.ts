// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
import {
  createStructuredMarkdownEditor,
  markdownLinkOpenHint,
  shouldOpenMarkdownLink,
  type StructuredMarkdownEditor,
} from "./structured-editor";
import { undo, redo } from "@milkdown/kit/prose/history";

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

  it.each([0, 1, 2, 3])("unfolds only sibling %s when all siblings are folded", async (index) => {
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = await createStructuredMarkdownEditor({
      parent,
      context: { kind: "piece" },
      markdown: ["first", "second", "third", "last"].map((label) => `- ${label}\n  - child`).join("\n"),
    });
    const markdown = editor.getMarkdown();
    const toggles = [...parent.querySelectorAll<HTMLButtonElement>(".fn-list-fold-toggle:not([hidden])")];
    expect(toggles).toHaveLength(4);
    const foldedStates = () => toggles.map((toggle) => toggle.closest("li")!.classList.contains("fn-list-item--folded"));
    toggles.forEach((toggle) => toggle.click());
    expect(foldedStates()).toEqual([true, true, true, true]);

    toggles[index].click();
    expect(foldedStates()).toEqual(toggles.map((_, sibling) => sibling !== index));
    expect(toggles.map((toggle) => toggle.getAttribute("aria-expanded")))
      .toEqual(toggles.map((_, sibling) => String(sibling === index)));
    expect(editor.getMarkdown()).toBe(markdown);

    toggles[index].click();
    expect(foldedStates()).toEqual([true, true, true, true]);
  });

  it.each([false, true].flatMap((folded) => [0, 2, 4].map((offset) => ({ folded, offset }))))(
    "splits parent text at $offset with folded=$folded while retaining its subtree",
    async ({ folded, offset }) => {
      const parent = document.createElement("div");
      document.body.append(parent);
      editor = await createStructuredMarkdownEditor({ parent, context: { kind: "piece" },
        markdown: "- ABCD\n  - child\n    - grandchild\n- next" });
      if (folded) parent.querySelector<HTMLButtonElement>(".fn-list-fold-toggle:not([hidden])")!.click();
      const before = editor.getMarkdown();
      editor.withView((view) => {
        view.state.doc.descendants((node, pos) => {
          if (node.isText && node.text === "ABCD") editor!.setSelection(pos + offset);
        });
      });
      editor.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      editor.withView((view) => {
        const list = view.state.doc.firstChild!;
        const original = list.firstChild!;
        const children = original.child(1);
        expect(original.firstChild!.textContent).toBe("ABCD".slice(0, offset));
        expect(list.childCount).toBe(folded ? 3 : 2);
        const added = folded ? list.child(1) : children.firstChild!;
        expect(added.childCount).toBe(1);
        expect(added.textContent).toBe("ABCD".slice(offset));
        expect(children.childCount).toBe(folded ? 1 : 2);
        const child = children.child(folded ? 0 : 1);
        expect(child.firstChild!.textContent).toBe("child");
        expect(child.child(1).textContent).toBe("grandchild");
        expect(view.state.selection.$from.parent).toBe(added.firstChild);
        expect(view.state.selection.$from.parentOffset).toBe(0);
        const after = editor!.getMarkdown();
        expect(undo(view.state, view.dispatch)).toBe(true);
        expect(editor!.getMarkdown()).toBe(before);
        expect(redo(view.state, view.dispatch)).toBe(true);
        expect(editor!.getMarkdown()).toBe(after);
      });
      expect(parent.querySelector("li")!.classList.contains("fn-list-item--folded")).toBe(folded);
    },
  );

  it.each([false, true])("inserts a soft break without moving children with folded=%s", async (folded) => {
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = await createStructuredMarkdownEditor({ parent, context: { kind: "piece" },
      markdown: "- ABCD\n  - child" });
    if (folded) parent.querySelector<HTMLButtonElement>(".fn-list-fold-toggle:not([hidden])")!.click();
    editor.withView((view) => view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "ABCD") editor!.setSelection(pos + 2);
    }));
    editor.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    editor.withView((view) => {
      const list = view.state.doc.firstChild!;
      expect(list.childCount).toBe(1);
      expect(list.firstChild!.child(1).textContent).toBe("child");
      const paragraph = list.firstChild!.firstChild!;
      expect(paragraph.child(1).type.name).toBe("hardbreak");
      expect(paragraph.textContent).toBe("AB\nCD");
    });
    expect(parent.querySelector("li")!.classList.contains("fn-list-item--folded")).toBe(folded);
  });

  it.each([false, true])("preserves rich text and nested folds inside ordered task lists with folded=%s", async (folded) => {
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = await createStructuredMarkdownEditor({ parent, context: { kind: "piece" },
      markdown: "- outer\n\n  3. [x] AB**CD**\n     - [x] child\n       - grandchild\n  4. next" });
    const toggles = parent.querySelectorAll<HTMLButtonElement>(".fn-list-fold-toggle:not([hidden])");
    toggles[2].click();
    if (folded) toggles[1].click();
    editor.withView((view) => view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "AB") editor!.setSelection(pos + 2);
    }));
    editor.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    editor.withView((view) => {
      const ordered = view.state.doc.firstChild!.firstChild!.child(1);
      expect(ordered.attrs.order).toBe(3);
      const original = ordered.firstChild!;
      expect(original.attrs.checked).toBe(true);
      expect(original.firstChild!.textContent).toBe("AB");
      const children = original.child(1);
      const added = folded ? ordered.child(1) : children.firstChild!;
      expect(added.attrs.checked).toBe(false);
      expect(added.firstChild!.firstChild!.marks.map((mark) => mark.type.name)).toContain("strong");
      expect(added.textContent).toBe("CD");
      expect(children.child(folded ? 0 : 1).firstChild!.textContent).toBe("child");
    });
    const foldedItems = [...parent.querySelectorAll("li.fn-list-item--folded")];
    expect(foldedItems).toHaveLength(folded ? 2 : 1);
    expect(foldedItems.some((item) => item.querySelector("p")?.textContent === "child")).toBe(true);
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
    initialSource.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    editor.withView((view) => expect(view.state.selection.constructor.name).not.toBe("NodeSelection"));
    parent.querySelector<HTMLElement>(".fn-quote-card__header")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    const label = parent.querySelector<HTMLInputElement>('[aria-label="引用来源名称"]')!;
    const url = parent.querySelector<HTMLInputElement>('[aria-label="引用来源链接"]')!;
    const sourceEditor = parent.querySelector<HTMLElement>(".fn-quote-card__source-editor")!;
    expect(sourceEditor.hidden).toBe(true);
    const anchor = parent.querySelector<HTMLAnchorElement>(".fn-quote-card__source a")!;
    anchor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
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
    parent.querySelector<HTMLAnchorElement>(".fn-quote-card__source a")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
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

  it("opens ordinary Markdown links only with the platform modifier", async () => {
    vi.mocked(invoke).mockClear();
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = await createStructuredMarkdownEditor({
      parent,
      context: { kind: "piece" },
      markdown: "Read [the docs](https://docs.example.com).",
    });

    const anchor = parent.querySelector<HTMLAnchorElement>('a[href="https://docs.example.com"]')!;
    anchor.click();
    expect(invoke).not.toHaveBeenCalledWith("open_url", { url: "https://docs.example.com" });

    anchor.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("https://docs.example.com · 按住 Ctrl 并点击以打开链接");
    expect(anchor.classList.contains("fn-markdown-link-ready")).toBe(false);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }));
    expect(anchor.classList.contains("fn-markdown-link-ready")).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
    expect(anchor.classList.contains("fn-markdown-link-ready")).toBe(false);
    window.dispatchEvent(new Event("blur"));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    anchor.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, ctrlKey: true }));
    expect(anchor.classList.contains("fn-markdown-link-ready")).toBe(true);
    editor.contentDOM.dispatchEvent(new MouseEvent("mouseleave"));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(anchor.classList.contains("fn-markdown-link-ready")).toBe(false);
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));

    expect(invoke).toHaveBeenCalledWith("open_url", { url: "https://docs.example.com" });
  });

  it("uses Command on macOS and Ctrl on other platforms", () => {
    expect(markdownLinkOpenHint("MacIntel")).toContain("⌘");
    expect(shouldOpenMarkdownLink({ metaKey: true, ctrlKey: false }, "MacIntel")).toBe(true);
    expect(shouldOpenMarkdownLink({ metaKey: false, ctrlKey: true }, "MacIntel")).toBe(false);
    expect(markdownLinkOpenHint("Win32")).toContain("Ctrl");
    expect(shouldOpenMarkdownLink({ metaKey: false, ctrlKey: true }, "Win32")).toBe(true);
    expect(shouldOpenMarkdownLink({ metaKey: true, ctrlKey: false }, "Win32")).toBe(false);
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
