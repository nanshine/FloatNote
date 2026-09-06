// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { undo } from "@milkdown/kit/prose/history";
import { createStructuredMarkdownEditor, type StructuredMarkdownEditor } from "../shared/markdown/structured-editor";
import { annotationsFromMarks, applyMetadataMarks, applyQuoteSources, createStructuredInbox, quoteSourcesFromNodes } from "./structured-inbox";

const eventListeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, listener: (event: { payload: unknown }) => void) => {
    eventListeners.set(name, listener);
    return () => eventListeners.delete(name);
  }),
}));

if (!Range.prototype.getClientRects) {
  Object.defineProperty(Range.prototype, "getClientRects", { value: () => [] });
}

describe("structured inbox annotation bridge", () => {
  let editor: StructuredMarkdownEditor | undefined;
  afterEach(async () => {
    await editor?.destroy();
    document.body.replaceChildren();
  });

  it("maps Markdown offsets to marks and back after canonical serialization", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const markdown = "A **marked** value";
    editor = await createStructuredMarkdownEditor({ parent, context: { kind: "inbox" }, markdown });
    editor.withView((view) => applyMetadataMarks(view, markdown, {
      tags: [{ id: "focus", name: "重点", color: "#f00" }],
      annotations: [{ id: "ann-1", tagId: "focus", from: 4, to: 10 }],
      quoteSources: [],
    }));
    expect(parent.querySelector("[data-fn-annotation]")?.textContent).toBe("marked");
    expect(editor.withView((view) => annotationsFromMarks(view, editor!.getMarkdown()))).toEqual([
      { id: "ann-1", tagId: "focus", from: 4, to: 10 },
    ]);
  });

  it("preserves overlapping annotations as independent ProseMirror marks", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const markdown = "overlapping text";
    editor = await createStructuredMarkdownEditor({ parent, context: { kind: "inbox" }, markdown });
    editor.withView((view) => applyMetadataMarks(view, markdown, {
      tags: [
        { id: "a", name: "A", color: "#f00" },
        { id: "b", name: "B", color: "#00f" },
      ],
      annotations: [
        { id: "ann-a", tagId: "a", from: 0, to: 11 },
        { id: "ann-b", tagId: "b", from: 4, to: 16 },
      ],
      quoteSources: [],
    }));
    expect(editor.withView((view) => annotationsFromMarks(view, editor!.getMarkdown()))).toEqual([
      { id: "ann-a", tagId: "a", from: 0, to: 11 },
      { id: "ann-b", tagId: "b", from: 4, to: 16 },
    ]);
  });

  it("projects v2 quote source bundle ids onto quote-card nodes", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const markdown = "> [!quote] Terminal\n> captured";
    editor = await createStructuredMarkdownEditor({ parent, context: { kind: "inbox" }, markdown });
    editor.withView((view) => applyQuoteSources(view, markdown, {
      tags: [],
      annotations: [],
      quoteSources: [{ cardFrom: 0, bundleId: "com.apple.Terminal" }],
    }));
    expect(parent.querySelector(".fn-quote-card__source")?.textContent).toBe("Terminal");
    expect(editor.getMarkdown()).toContain("[!quote]");
    editor.withView((view) => view.dispatch(view.state.tr.insert(0,
      view.state.schema.nodes.paragraph.create(null, view.state.schema.text("before")))));
    expect(editor.withView((view) => quoteSourcesFromNodes(view, editor!.getMarkdown()))).toEqual([
      { cardFrom: 8, bundleId: "com.apple.Terminal" },
    ]);
  });

  it("creates and applies a tag through the in-menu controls", async () => {
    const parent = document.createElement("div");
    const projectionRoot = document.createElement("div");
    document.body.append(parent, projectionRoot);
    const saves: string[] = [];
    const inbox = await createStructuredInbox({
      parent,
      projectionRoot,
      onSave: (snapshot) => saves.push(snapshot),
    });
    editor = inbox.editor;
    inbox.load("selected text", { tags: [], annotations: [], quoteSources: [] });
    editor.withView((view) => editor!.setSelection(1, view.state.doc.content.size - 1));
    editor.contentDOM.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }));
    const launch = [...document.querySelectorAll<HTMLButtonElement>(".fn-menu__item")]
      .find((button) => button.textContent === "新建标签并应用");
    expect(launch).toBeTruthy();
    launch!.click();
    const input = document.querySelector<HTMLInputElement>(".annotation-menu-create input")!;
    input.value = "重点";
    document.querySelector<HTMLButtonElement>(".annotation-menu-create-button")!.click();
    expect(inbox.metadata().tags.map((tag) => tag.name)).toEqual(["重点"]);
    expect(parent.querySelector("[data-fn-annotation]")?.textContent).toBe("selected text");
    expect(saves.at(-1)).toContain("floatnote:tags:v2");
    expect(saves.at(-1)).toContain("floatnote:ann:v2");
  });

  it("shows each existing tag color in the selection menu", async () => {
    const parent = document.createElement("div");
    const projectionRoot = document.createElement("div");
    document.body.append(parent, projectionRoot);
    const inbox = await createStructuredInbox({ parent, projectionRoot, onSave: () => undefined });
    editor = inbox.editor;
    inbox.load("selected text", {
      tags: [{ id: "homework", name: "作业", color: "#8b5cf6" }],
      annotations: [],
      quoteSources: [],
    });
    editor.setSelection(1, editor.withView((view) => view.state.doc.content.size - 1));

    editor.contentDOM.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    const item = document.querySelector<HTMLButtonElement>(".annotation-menu-tag")!;
    expect(item.textContent).toBe("作业");
    expect(item.style.getPropertyValue("--c")).toBe("#8b5cf6");
    expect(item.querySelector(".annotation-menu-dot")).not.toBeNull();
  });

  it("restores the tag definition and filter after undoing a tag deletion", async () => {
    const parent = document.createElement("div");
    const projectionRoot = document.createElement("div");
    document.body.append(parent, projectionRoot);
    const inbox = await createStructuredInbox({ parent, projectionRoot, onSave: () => undefined });
    editor = inbox.editor;
    inbox.load("tagged text", {
      tags: [{ id: "homework", name: "作业", color: "#8b5cf6" }],
      annotations: [{ id: "ann-homework", tagId: "homework", from: 0, to: 6 }],
      quoteSources: [],
    });
    const filter = inbox.tagBar.querySelector<HTMLButtonElement>(".tag-filter-disc")!;
    filter.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    document.querySelector<HTMLButtonElement>(".fn-menu__item--danger")!.click();
    expect(inbox.metadata().tags).toEqual([]);
    expect(inbox.tagBar.classList.contains("tag-bar--hidden")).toBe(true);

    editor.withView((view) => undo(view.state, view.dispatch));

    expect(inbox.metadata().tags).toEqual([{ id: "homework", name: "作业", color: "#8b5cf6" }]);
    expect(inbox.metadata().annotations).toEqual([
      { id: "ann-homework", tagId: "homework", from: 0, to: 6 },
    ]);
    expect(inbox.tagBar.classList.contains("tag-bar--hidden")).toBe(false);
    expect(inbox.tagBar.querySelector(".tag-filter-name")?.textContent).toBe("作业");
  });

  it("removes one selected annotation without deleting the shared tag or its other annotation", async () => {
    const parent = document.createElement("div");
    const projectionRoot = document.createElement("div");
    document.body.append(parent, projectionRoot);
    const inbox = await createStructuredInbox({ parent, projectionRoot, onSave: () => undefined });
    editor = inbox.editor;
    inbox.load("first second", {
      tags: [{ id: "homework", name: "作业", color: "#8b5cf6" }],
      annotations: [
        { id: "ann-first", tagId: "homework", from: 0, to: 5 },
        { id: "ann-second", tagId: "homework", from: 6, to: 12 },
      ],
      quoteSources: [],
    });
    editor.setSelection(1, 6);
    editor.contentDOM.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    const remove = [...document.querySelectorAll<HTMLButtonElement>(".annotation-menu-remove")]
      .find((button) => button.textContent === "移除「作业」标注");
    expect(remove).toBeTruthy();
    remove!.click();

    expect(inbox.metadata().tags.map((tag) => tag.id)).toEqual(["homework"]);
    expect(inbox.metadata().annotations).toEqual([
      { id: "ann-second", tagId: "homework", from: 6, to: 12 },
    ]);
    expect(parent.querySelectorAll("[data-fn-annotation]")).toHaveLength(1);
    expect(parent.querySelector("[data-fn-annotation]")?.textContent).toBe("second");
  });

  it("replaces the editor with the filtered projection inside the same scroll surface", async () => {
    const parent = document.createElement("div");
    const projectionRoot = document.createElement("div");
    projectionRoot.hidden = true;
    parent.append(projectionRoot);
    document.body.append(parent);
    const inbox = await createStructuredInbox({ parent, projectionRoot, onSave: () => undefined });
    editor = inbox.editor;
    inbox.load("first tagged text", {
      tags: [{ id: "focus", name: "重点", color: "#f00" }],
      annotations: [{ id: "ann-1", tagId: "focus", from: 0, to: 5 }],
      quoteSources: [],
    });

    inbox.setFilter("focus");

    expect(parent.hidden).toBe(false);
    expect(editor.element.hidden).toBe(true);
    expect(projectionRoot.hidden).toBe(false);
    expect(projectionRoot.textContent).toContain("first");
  });

  it("returns to the editable surface when the next project lacks the active tag", async () => {
    const parent = document.createElement("div");
    const projectionRoot = document.createElement("div");
    projectionRoot.hidden = true;
    parent.append(projectionRoot);
    document.body.append(parent);
    const inbox = await createStructuredInbox({ parent, projectionRoot, onSave: () => undefined });
    editor = inbox.editor;
    inbox.load("tagged", {
      tags: [{ id: "focus", name: "重点", color: "#f00" }],
      annotations: [{ id: "ann-1", tagId: "focus", from: 0, to: 6 }],
      quoteSources: [],
    });
    inbox.setFilter("focus");

    inbox.load("new project", { tags: [], annotations: [], quoteSources: [] });

    expect(editor.element.isConnected).toBe(true);
    expect(parent.querySelector(".fn-note-structured-editor")).toBe(editor.element);
    expect(editor.element.hidden).toBe(false);
    expect(projectionRoot.hidden).toBe(true);
    expect(parent.querySelector(".editor")?.textContent).toContain("new project");
  });

  it("inserts a captured quote at the structural caret instead of the document end", async () => {
    const parent = document.createElement("div");
    const projectionRoot = document.createElement("div");
    document.body.append(parent, projectionRoot);
    const inbox = await createStructuredInbox({ parent, projectionRoot, onSave: () => undefined });
    editor = inbox.editor;
    inbox.load("first\n\nsecond", { tags: [], annotations: [], quoteSources: [] });
    editor.withView((view) => {
      let afterFirst = 1;
      view.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === "first") afterFirst = pos + node.nodeSize;
      });
      editor!.setSelection(afterFirst);
    });
    eventListeners.get("quote-captured")?.({
      payload: {
        text: "captured",
        html: null,
        source: { kind: "app", title: "终端", url: null, bundleId: "com.apple.Terminal" },
      },
    });
    const markdown = editor.getMarkdown();
    expect(markdown.indexOf("[!quote]")).toBeGreaterThan(markdown.indexOf("first"));
    expect(markdown.indexOf("[!quote]")).toBeLessThan(markdown.indexOf("second"));
    expect(parent.querySelector(".fn-quote-card__source")?.textContent).toBe("终端");
  });
});
