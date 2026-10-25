// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createStructuredMarkdownEditor, type StructuredMarkdownEditor } from "./structured-editor";
import { selectionTable } from "./selection-state";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
let editor: StructuredMarkdownEditor;
afterEach(async () => { await editor?.destroy(); document.body.replaceChildren(); });

it("highlights an empty line only when its line break is selected, without changing Markdown", async () => {
  const parent = document.createElement("div");
  document.body.append(parent);
  editor = await createStructuredMarkdownEditor({ parent, markdown: "before\n\nafter", context: { kind: "piece" } });
  let emptyPosition = 0;
  editor.withView((view) => {
    emptyPosition = view.state.doc.firstChild!.nodeSize;
    view.dispatch(view.state.tr.insert(emptyPosition, view.state.schema.nodes.paragraph.create()));
  });
  const original = editor.getMarkdown();
  const marker = () => parent.querySelector(".fn-empty-line-selected");
  const end = editor.withView((view) => view.state.doc.content.size - 1);
  editor.setSelection(1, end);
  expect(marker()?.textContent).toBe("");
  editor.setSelection(end, 1);
  expect(marker()).not.toBeNull();
  editor.setSelection(1, emptyPosition + 1);
  expect(marker()).toBeNull();
  editor.setSelection(emptyPosition + 1, end);
  expect(marker()).not.toBeNull();
  editor.setSelection(emptyPosition + 1);
  expect(marker()).toBeNull();
  expect(editor.getMarkdown()).toBe(original);
  expect(document.querySelector('[aria-label="选区操作"]')).toBeNull();
});

it("hides table tools when a selection extends outside the table", async () => {
  const parent = document.createElement("div");
  document.body.append(parent);
  editor = await createStructuredMarkdownEditor({ parent, markdown: "| A | B |\n| --- | --- |\n| one | two |\n\nafter", context: { kind: "piece" } });
  editor.withView((view) => {
    let cell = 0;
    view.state.doc.descendants((node, pos) => { if (!cell && node.type.name === "table_cell") cell = pos + 2; });
    editor.setSelection(cell, view.state.doc.content.size - 1);
    expect(selectionTable(view.state)).toBeNull();
  });
  expect(parent.querySelector<HTMLElement>(".fn-table-tools")!.hidden).toBe(true);
});
