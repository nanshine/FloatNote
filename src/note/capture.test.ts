// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { undo } from "@milkdown/kit/prose/history";
import { createStructuredMarkdownEditor, type StructuredMarkdownEditor } from "../shared/markdown/structured-editor";
import { captureQuote } from "./capture";

if (!Range.prototype.getClientRects) {
  Object.defineProperty(Range.prototype, "getClientRects", { value: () => [] });
}

describe("standalone document capture", () => {
  let editor: StructuredMarkdownEditor;
  afterEach(async () => {
    await editor?.destroy();
    document.body.replaceChildren();
  });

  it("inserts at the saved caret, merges repeated sources, and supports undo", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = await createStructuredMarkdownEditor({ parent, context: { kind: "piece" }, markdown: "first\n\nsecond" });
    editor.setSelection(6);
    const source = { kind: "app" as const, title: "Terminal", url: null, bundleId: "com.apple.Terminal" };
    captureQuote(editor, { text: "one", html: null, source });
    captureQuote(editor, { text: "two", html: null, source: { ...source, title: "Another terminal window" } });
    const markdown = editor.getMarkdown();
    expect(markdown.match(/\[!quote\]/g)).toHaveLength(1);
    expect(markdown.indexOf("[!quote]")).toBeGreaterThan(markdown.indexOf("first"));
    expect(markdown.indexOf("two")).toBeLessThan(markdown.indexOf("second"));
    expect(parent.querySelector(".fn-quote-card__source")?.textContent).toBe("Terminal");
    editor.withView((view) => undo(view.state, view.dispatch));
    expect(editor.getMarkdown()).not.toContain("two");
  });

  it("creates a separate card for another source and discards previous document content on load", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    editor = await createStructuredMarkdownEditor({ parent, context: { kind: "piece" }, markdown: "" });
    captureQuote(editor, { text: "old material", html: null, source: null });
    editor.load("new document");
    editor.setSelection(13);
    captureQuote(editor, { text: "new material", html: null, source: { kind: "app", title: "A", url: null, bundleId: "a" } });
    captureQuote(editor, { text: "another source", html: null, source: { kind: "app", title: "B", url: null, bundleId: "b" } });
    expect(editor.getMarkdown()).not.toContain("old material");
    expect(editor.getMarkdown().match(/\[!quote\]/g)).toHaveLength(2);
  });
});
