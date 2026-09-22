// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { undo, redo } from "@milkdown/kit/prose/history";
import { undoInputRule } from "@milkdown/kit/prose/inputrules";
import { createStructuredMarkdownEditor, type StructuredMarkdownEditor } from "./structured-editor";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
if (!Range.prototype.getClientRects) Object.defineProperty(Range.prototype, "getClientRects", { value: () => [] });
if (!Range.prototype.getBoundingClientRect) Object.defineProperty(Range.prototype, "getBoundingClientRect", { value: () => new DOMRect() });

describe("link editing", () => {
  let editor: StructuredMarkdownEditor;
  async function create(markdown = "") {
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = await createStructuredMarkdownEditor({ parent, markdown, context: { kind: "piece" } });
    return editor;
  }
  function type(text: string) {
    editor.withView((view) => {
      for (const char of text) {
        const { from, to } = view.state.selection;
        const handled = view.someProp("handleTextInput", (handler) => handler(view, from, to, char, () => view.state.tr.insertText(char)));
        if (!handled) view.dispatch(view.state.tr.insertText(char));
      }
    });
  }
  function shortcut() {
    editor.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
  }
  function input(name: string) { return document.querySelector<HTMLInputElement>(`.fn-link-dialog:not([hidden]) input[name="${name}"]`)!; }
  function links() { return [...editor.contentDOM.querySelectorAll("a")]; }
  function paste(text: string, plain = false, html?: string) {
    editor.withView((view) => {
      // Exercise the actual ProseMirror clipboard parser and handlePaste path.
      if (plain) view.someProp("transformPastedText", (fn) => fn(text, true, view));
      if (plain) {
        const slice = view.someProp("clipboardTextParser", (fn) => fn(text, view.state.selection.$from, true, view))!;
        const event = { clipboardData: { getData: () => text } } as unknown as ClipboardEvent;
        const handled = view.someProp("handlePaste", (fn) => fn(view, event, slice));
        if (!handled) view.dispatch(view.state.tr.replaceSelection(slice));
      } else {
        const event = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", { value: { getData: (format: string) => format === "text/plain" ? text : html ?? "", files: [], types: ["text/plain"] } });
        view.dom.dispatchEvent(event);
      }
    });
  }
  afterEach(async () => { await editor?.destroy(); document.body.replaceChildren(); });

  it("converts typed Markdown, preserves URL parentheses and survives save/load", async () => {
    await create();
    type("See [FloatNote](https://example.com/a_(b)?q=1#intro)");
    expect(links()).toHaveLength(1);
    expect(links()[0].textContent).toBe("FloatNote");
    expect(links()[0].getAttribute("href")).toBe("https://example.com/a_(b)?q=1#intro");
    expect(editor.getMarkdown()).toContain("[FloatNote](https://example.com/");
    const saved = editor.getMarkdown();
    editor.load(saved);
    expect(editor.getMarkdown()).toBe(saved);
    expect(links()[0].getAttribute("href")).toBe("https://example.com/a_(b)?q=1#intro");
  });

  it("allows undoing automatic conversion back to literal syntax", async () => {
    await create();
    type("[FloatNote](https://example.com)");
    editor.withView((view) => expect(undoInputRule(view.state, view.dispatch)).toBe(true));
    expect(links()).toHaveLength(0);
    expect(editor.contentDOM.textContent).toBe("[FloatNote](https://example.com)");
    type(" ");
    expect(links()).toHaveLength(0);
  });

  it("undoes automatic links with the platform keyboard shortcut", async () => {
    await create(); type("[FloatNote](https://example.com)");
    editor.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
    expect(links()).toHaveLength(0);
    expect(editor.contentDOM.textContent).toBe("[FloatNote](https://example.com)");
  });

  it.each(["[FloatNote](", "\\[FloatNote](https://example.com)", "[bad](javascript:alert(1))"])("leaves incomplete, escaped or unsafe syntax literal: %s", async (text) => {
    await create(); type(text); expect(links()).toHaveLength(0);
  });

  it.each([
    ["https://example.com/a_(b)。 ", "https://example.com/a_(b)"],
    ["www.example.com ", "https://www.example.com"],
    ["hello@example.com ", "mailto:hello@example.com"],
  ])("recognizes completed bare destinations: %s", async (text, href) => {
    await create(); type(text);
    expect(links()[0]?.getAttribute("href")).toBe(href);
    expect(editor.contentDOM.textContent).toBe(text);
  });

  it("recognizes a bare URL on Enter", async () => {
    await create(); type("https://example.com");
    editor.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(links()[0]?.getAttribute("href")).toBe("https://example.com");
    expect(editor.contentDOM.querySelectorAll("p")).toHaveLength(2);
  });

  it("does not extend the link at its end but does preserve it inside", async () => {
    await create("[Hello](https://example.com)");
    editor.setSelection(3); type("X");
    expect(links()[0].textContent).toBe("HeXllo");
    editor.setSelection(7); type(" next");
    expect(links()[0].textContent).toBe("HeXllo");
    expect(editor.contentDOM.textContent).toBe("HeXllo next");
  });

  it.each(["https://example.com", "[FloatNote](https://example.com)"])("pastes complete links: %s", async (text) => {
    await create(); paste(text); expect(links()).toHaveLength(1);
  });

  it("keeps selected text and formatting when pasting a URL, with undo and redo", async () => {
    await create("**Float**Note"); editor.setSelection(1, 10);
    paste("https://example.com");
    expect(editor.contentDOM.textContent).toBe("FloatNote");
    expect(editor.contentDOM.querySelector("strong")?.textContent).toBe("Float");
    expect(links().every((link) => link.getAttribute("href") === "https://example.com")).toBe(true);
    editor.withView((view) => undo(view.state, view.dispatch));
    expect(links()).toHaveLength(0);
    editor.withView((view) => redo(view.state, view.dispatch));
    expect(links().length).toBeGreaterThan(0);
  });

  it("preserves rich HTML links and treats explicit plain-text paste literally", async () => {
    await create(); paste("FloatNote", false, '<a href="https://example.com"><strong>FloatNote</strong></a>');
    expect(links()[0].textContent).toBe("FloatNote");
    expect(editor.contentDOM.querySelector("strong")).toBeTruthy();
    editor.load("selected"); editor.setSelection(1, 9);
    paste("https://example.com", true);
    expect(links()).toHaveLength(0);
    expect(editor.contentDOM.textContent).toBe("https://example.com");
    type(" "); expect(links()).toHaveLength(0);
  });

  it("leaves URLs in inline code alone", async () => {
    await create("`code`"); editor.setSelection(3);
    type(" https://example.com "); paste("[FloatNote](https://example.com)");
    expect(links()).toHaveLength(0);
    shortcut(); expect(document.querySelector(".fn-link-dialog:not([hidden])")).toBeNull();
  });

  it("autosaves valid input without buttons and closes on outside click", async () => {
    await create("FloatNote"); editor.setSelection(1, 10); shortcut();
    expect(document.querySelectorAll(".fn-link-dialog button")).toHaveLength(0);
    input("url").value = "https://example.com";
    input("url").dispatchEvent(new Event("input", { bubbles: true }));
    expect(links()[0].getAttribute("href")).toBe("https://example.com");
    expect(document.querySelector(".fn-link-dialog:not([hidden])")).toBeTruthy();
    input("label").value = "Updated";
    input("label").dispatchEvent(new Event("input", { bubbles: true }));
    input("label").value = "Updated again";
    input("label").dispatchEvent(new Event("input", { bubbles: true }));
    expect(editor.contentDOM.textContent).toBe("Updated again");
    document.querySelector<HTMLElement>(".fn-link-dialog__backdrop")!.click();
    expect(document.querySelector(".fn-link-dialog:not([hidden])")).toBeNull();
    expect(links()[0].textContent).toBe("Updated again");
    expect(document.activeElement).toBe(editor.contentDOM);
  });

  it("autosaves across bold runs, discards incomplete input and supports undo", async () => {
    await create("[**Float**Note](https://example.com)"); editor.setSelection(3); shortcut();
    input("url").value = "https://new.example.com";
    input("url").dispatchEvent(new Event("input", { bubbles: true }));
    expect(links().every((link) => link.getAttribute("href") === "https://new.example.com")).toBe(true);
    expect(editor.contentDOM.querySelector("strong")?.textContent).toBe("Float");
    input("url").value = "https://";
    input("url").dispatchEvent(new Event("input", { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(links().every((link) => link.getAttribute("href") === "https://new.example.com")).toBe(true);
    editor.withView((view) => undo(view.state, view.dispatch));
    expect(links().every((link) => link.getAttribute("href") === "https://example.com")).toBe(true);
  });

  it("waits until composition finishes before saving the label", async () => {
    await create("[FloatNote](https://example.com)"); editor.setSelection(3); shortcut();
    const label = input("label");
    label.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    label.value = "中文";
    label.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    expect(links()[0].textContent).toBe("FloatNote");
    label.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(links()[0].textContent).toBe("中文");
  });

  it("rejects unsupported destinations and cannot edit read-only documents", async () => {
    await create(); shortcut(); input("url").value = "javascript:alert(1)"; input("url").dispatchEvent(new Event("input", { bubbles: true }));
    expect(input("url").getAttribute("aria-invalid")).toBe("true");
    expect(links()).toHaveLength(0);
    editor.setReadOnly(true); shortcut();
    expect(document.querySelector(".fn-link-dialog:not([hidden])")).toBeNull();
  });
});
