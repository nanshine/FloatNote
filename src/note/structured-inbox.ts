import {
  annotationProjection,
  encodeInbox,
  freeColors,
  mapAnnotations,
  mapQuoteSources,
  PALETTE,
  type TagDef,
  type InboxMetadata,
  type TextAnnotation,
} from "@floatnote/note-logic";
import { listen } from "@tauri-apps/api/event";
import type { MarkType, Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { createStructuredMarkdownEditor, type StructuredMarkdownEditor } from "../shared/markdown/structured-editor";
import { createMenu } from "../shared/ui/menu";
import { showToast } from "../shared/toast";
import { isImeComposing } from "../shared/keyboard";
import { htmlToMarkdown } from "../shared/markdown/from-html";
import { buildCaretInsert } from "./append";
import { buildQuoteAppendChange, buildQuoteBlock, quoteCardRanges, resolveMergeTarget, type Source } from "./quote";

const EMPTY_METADATA: InboxMetadata = { tags: [], annotations: [], quoteSources: [] };
let idSequence = 0;

function annotationId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `ann-${uuid.toLowerCase()}`;
  idSequence += 1;
  return `ann-${Date.now().toString(36)}-${idSequence.toString(36)}`;
}

function tagId(name: string, existing: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "tag";
  if (!existing.includes(base)) return base;
  let suffix = 2;
  while (existing.includes(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

interface TextNodePosition {
  node: ProseNode;
  from: number;
  sourceFrom: number;
  sourceTo: number;
}

/** Align ProseMirror text nodes with their literal text in Markdown. Markdown
 * punctuation is skipped, so positions remain stable through formatting. */
function alignTextNodes(doc: ProseNode, markdown: string): TextNodePosition[] {
  const aligned: TextNodePosition[] = [];
  let cursor = 0;
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const found = markdown.indexOf(node.text, cursor);
    if (found < 0) return;
    aligned.push({ node, from: pos, sourceFrom: found, sourceTo: found + node.text.length });
    cursor = found + node.text.length;
  });
  return aligned;
}

function applyMetadataMarks(view: EditorView, markdown: string, metadata: InboxMetadata): void {
  const type = view.state.schema.marks.floatnote_annotation;
  if (!type) return;
  const tags = new Map(metadata.tags.map((tag) => [tag.id, tag]));
  const aligned = alignTextNodes(view.state.doc, markdown);
  const tr = view.state.tr.removeMark(0, view.state.doc.content.size, type);
  for (const annotation of metadata.annotations) {
    const tag = tags.get(annotation.tagId);
    if (!tag) continue;
    for (const text of aligned) {
      const from = Math.max(annotation.from, text.sourceFrom);
      const to = Math.min(annotation.to, text.sourceTo);
      if (from >= to) continue;
      tr.addMark(
        text.from + (from - text.sourceFrom),
        text.from + (to - text.sourceFrom),
        type.create({ id: annotation.id, tagId: tag.id, color: tag.color, name: tag.name }),
      );
    }
  }
  tr.setMeta("addToHistory", false);
  view.dispatch(tr);
}

function annotationsFromMarks(view: EditorView, markdown: string): TextAnnotation[] {
  const aligned = alignTextNodes(view.state.doc, markdown);
  const ranges = new Map<string, TextAnnotation[]>();
  for (const text of aligned) {
    for (const mark of text.node.marks) {
      if (mark.type.name !== "floatnote_annotation" || !mark.attrs.id || !mark.attrs.tagId) continue;
      const key = `${mark.attrs.id}\u0000${mark.attrs.tagId}`;
      const pieces = ranges.get(key) ?? [];
      const previous = pieces.at(-1);
      if (previous && previous.to === text.sourceFrom) previous.to = text.sourceTo;
      else pieces.push({ id: mark.attrs.id, tagId: mark.attrs.tagId, from: text.sourceFrom, to: text.sourceTo });
      ranges.set(key, pieces);
    }
  }
  return [...ranges.values()].flat().sort((a, b) => a.from - b.from || a.to - b.to);
}

/** Annotation marks participate in ProseMirror history, while tag definitions
 * live in Inbox metadata. Reading definitions back from live marks keeps those
 * two layers coherent when undo restores a mark after its tag was deleted. */
function tagDefinitionsFromMarks(view: EditorView): TagDef[] {
  const definitions = new Map<string, TagDef>();
  view.state.doc.descendants((node) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type.name !== "floatnote_annotation") continue;
      const { tagId: id, name, color } = mark.attrs;
      if (
        typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) ||
        typeof name !== "string" || !name.trim() || /[\r\n]/.test(name) ||
        typeof color !== "string" || !/^#[0-9a-fA-F]{3,8}$/.test(color)
      ) continue;
      definitions.set(id, { id, name, color });
    }
  });
  return [...definitions.values()];
}

function reconcileTagDefinitions(tags: TagDef[], markedTags: TagDef[]): TagDef[] {
  const live = new Map(markedTags.map((tag) => [tag.id, tag]));
  const reconciled = tags.map((tag) => live.get(tag.id) ?? tag);
  const known = new Set(tags.map((tag) => tag.id));
  for (const tag of markedTags) {
    if (!known.has(tag.id)) reconciled.push(tag);
  }
  return reconciled;
}

function annotationMarksAtSelection(view: EditorView, annotationType: MarkType) {
  const { from, to, empty, $from } = view.state.selection;
  const marks = new Map<string, ReturnType<MarkType["create"]>>();
  const collect = (node: ProseNode) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type === annotationType && typeof mark.attrs.id === "string" && mark.attrs.id) {
        marks.set(mark.attrs.id, mark);
      }
    }
  };
  if (empty) {
    for (const mark of view.state.storedMarks ?? $from.marks()) {
      if (mark.type === annotationType && typeof mark.attrs.id === "string" && mark.attrs.id) {
        marks.set(mark.attrs.id, mark);
      }
    }
    if ($from.nodeAfter) collect($from.nodeAfter);
    if ($from.nodeBefore) collect($from.nodeBefore);
  } else {
    view.state.doc.nodesBetween(from, to, collect);
  }
  return [...marks.values()];
}

function removeAnnotationMark(view: EditorView, annotationType: MarkType, annotationId: string): void {
  let transaction = view.state.tr;
  view.state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type === annotationType && mark.attrs.id === annotationId) {
        transaction = transaction.removeMark(pos, pos + node.nodeSize, mark);
      }
    }
  });
  if (transaction.steps.length) view.dispatch(transaction);
}

function applyQuoteSources(view: EditorView, markdown: string, metadata: InboxMetadata): void {
  const starts = [...markdown.matchAll(/^[ \t]*>\s*\[!quote\]/gim)].map((match) => match.index);
  let index = 0;
  let transaction = view.state.tr;
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== "quote_card") return;
    const source = metadata.quoteSources.find((item) => item.cardFrom === starts[index]);
    transaction = transaction.setNodeAttribute(pos, "bundleId", source?.bundleId ?? null);
    index += 1;
  });
  if (transaction.steps.length) {
    transaction.setMeta("addToHistory", false);
    view.dispatch(transaction);
  }
}

function quoteSourcesFromNodes(view: EditorView, markdown: string): InboxMetadata["quoteSources"] {
  const starts = [...markdown.matchAll(/^[ \t]*>\s*\[!quote\]/gim)].map((match) => match.index);
  const sources: InboxMetadata["quoteSources"] = [];
  let index = 0;
  view.state.doc.descendants((node) => {
    if (node.type.name !== "quote_card") return;
    const bundleId = typeof node.attrs.bundleId === "string" ? node.attrs.bundleId : "";
    if (bundleId && starts[index] != null) sources.push({ cardFrom: starts[index], bundleId });
    index += 1;
  });
  return sources;
}

export interface StructuredInboxHandle {
  editor: StructuredMarkdownEditor;
  tagBar: HTMLElement;
  metadata: () => InboxMetadata;
  load: (markdown: string, metadata: InboxMetadata) => void;
  snapshot: () => string;
  setFilter: (tagId: string | null) => void;
  setReadOnly: (readOnly: boolean) => void;
  refresh: () => void;
}

type QuotePayload = { text: string; html: string | null; source: Source | null };

export async function createStructuredInbox(options: {
  parent: HTMLElement;
  projectionRoot: HTMLElement;
  onSave: (snapshot: string) => void;
  onFocus?: () => void;
  resolveImageSrc?: (url: string) => string;
}): Promise<StructuredInboxHandle> {
  let metadata: InboxMetadata = structuredClone(EMPTY_METADATA);
  let activeTag: string | null = null;
  let loading = true;
  let readOnly = false;
  let lastCaretMarkdownOffset = 0;
  let editor!: StructuredMarkdownEditor;
  editor = await createStructuredMarkdownEditor({
    parent: options.parent,
    context: { kind: "inbox", resolveImageSrc: options.resolveImageSrc },
    placeholder: "在这里写点什么…",
    onFocus: options.onFocus,
    onSelectionChange(selection) {
      if (!editor) return;
      const offset = editor.markdownOffsetAt(selection.from);
      if (offset !== null) lastCaretMarkdownOffset = offset;
    },
    onChange(markdown) {
      if (loading) return;
      metadata = editor.withView((view) => ({
        ...metadata,
        tags: reconcileTagDefinitions(metadata.tags, tagDefinitionsFromMarks(view)),
        annotations: annotationsFromMarks(view, markdown),
        quoteSources: quoteSourcesFromNodes(view, markdown),
      }));
      options.onSave(encodeInbox(markdown, metadata));
      refresh();
    },
  });

  const tagBar = document.createElement("div");
  tagBar.className = "tag-bar";
  const all = document.createElement("button");
  all.type = "button";
  all.className = "tag-filter-all";
  all.innerHTML = '<i class="ph ph-squares-four"></i><span>全部</span>';
  const discs = document.createElement("div");
  discs.className = "tag-disc-row";
  tagBar.append(all, discs);

  const syncFilterVisibility = () => {
    options.projectionRoot.hidden = activeTag === null;
    editor.element.hidden = activeTag !== null;
  };

  const setFilter = (tagId: string | null) => {
    activeTag = tagId;
    syncFilterVisibility();
    refresh();
  };
  all.onclick = () => setFilter(null);

  function persistSnapshot(): void {
    if (loading) return;
    const markdown = editor.getMarkdown();
    metadata = {
      ...metadata,
      annotations: editor.withView((view) => annotationsFromMarks(view, markdown)),
      quoteSources: editor.withView((view) => quoteSourcesFromNodes(view, markdown)),
    };
    options.onSave(encodeInbox(markdown, metadata));
    refresh();
  }

  function newTagLauncher(
    view: EditorView,
    from: number,
    to: number,
    annotationType: MarkType,
    close: () => void,
  ): HTMLElement {
    const launch = document.createElement("button");
    launch.type = "button";
    launch.className = "fn-menu__item";
    launch.textContent = "新建标签并应用";
    launch.onclick = () => {
      const controls = document.createElement("div");
      controls.className = "annotation-menu-create";
      const input = document.createElement("input");
      input.className = "fn-control tag-add-input";
      input.placeholder = "标签名称";
      input.maxLength = 24;
      const swatches = document.createElement("div");
      swatches.className = "swatch-row";
      const free = freeColors(new Set(metadata.tags.map((tag) => tag.color.toLowerCase())));
      const choices = free.length ? PALETTE.filter((swatch) => free.includes(swatch.color)) : PALETTE;
      let selected = choices[0]?.color ?? PALETTE[0].color;
      for (const swatch of choices) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "swatch";
        button.style.setProperty("--c", swatch.color);
        button.setAttribute("aria-label", `选择颜色 ${swatch.color}`);
        button.classList.toggle("selected", swatch.color === selected);
        button.onclick = () => {
          selected = swatch.color;
          for (const item of swatches.children) item.classList.remove("selected");
          button.classList.add("selected");
        };
        swatches.append(button);
      }
      const commit = () => {
        const name = input.value.trim();
        if (!name) return void input.focus();
        const id = tagId(name, metadata.tags.map((tag) => tag.id));
        metadata = { ...metadata, tags: [...metadata.tags, { id, name, color: selected }] };
        view.dispatch(view.state.tr.addMark(from, to, annotationType.create({
          id: annotationId(), tagId: id, color: selected, name,
        })));
        persistSnapshot();
        close();
      };
      input.onkeydown = (event) => {
        if (isImeComposing(event)) return;
        if (event.key === "Enter") { event.preventDefault(); commit(); }
        if (event.key === "Escape") close();
      };
      const create = document.createElement("button");
      create.type = "button";
      create.className = "fn-menu__item annotation-menu-create-button";
      create.textContent = "创建并应用";
      create.onclick = commit;
      controls.append(input, swatches, create);
      launch.replaceWith(controls);
      input.focus();
    };
    return launch;
  }

  function refreshProjection(): void {
    if (!activeTag) return;
    const markdown = editor.getMarkdown();
    options.projectionRoot.replaceChildren();
    for (const segment of annotationProjection(markdown, metadata.annotations, activeTag)) {
      const item = document.createElement("div");
      item.className = "annotation-projection-item";
      item.tabIndex = 0;
      item.textContent = markdown.slice(segment.from, segment.to);
      item.ondblclick = () => {
        setFilter(null);
        editor.focus();
      };
      options.projectionRoot.append(item);
    }
  }

  function refresh(): void {
    tagBar.classList.toggle("tag-bar--hidden", metadata.tags.length === 0);
    all.classList.toggle("active", activeTag === null);
    discs.replaceChildren();
    for (const tag of metadata.tags) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tag-disc tag-filter-disc";
      button.classList.toggle("active", tag.id === activeTag);
      button.style.setProperty("--c", tag.color);
      button.innerHTML = '<span class="tag-filter-dot" aria-hidden="true"></span>';
      const label = document.createElement("span");
      label.className = "tag-filter-name";
      label.textContent = tag.name;
      button.append(label);
      button.onclick = () => setFilter(activeTag === tag.id ? null : tag.id);
      button.oncontextmenu = (event) => {
        event.preventDefault();
        const menu = createMenu();
        const rename = document.createElement("button");
        rename.type = "button";
        rename.className = "fn-menu__item";
        rename.textContent = "重命名标签";
        rename.onclick = () => {
          const name = window.prompt("标签名称", tag.name)?.trim();
          if (!name || name === tag.name) return void menu.hide();
          metadata = { ...metadata, tags: metadata.tags.map((item) => item.id === tag.id ? { ...item, name } : item) };
          editor.withView((view) => {
            let tr = view.state.tr;
            view.state.doc.descendants((node, pos) => {
              if (!node.isText) return;
              for (const mark of node.marks.filter((item) => item.type.name === "floatnote_annotation" && item.attrs.tagId === tag.id)) {
                tr = tr.removeMark(pos, pos + node.nodeSize, mark).addMark(pos, pos + node.nodeSize, mark.type.create({ ...mark.attrs, name }));
              }
            });
            if (tr.steps.length) view.dispatch(tr);
          });
          persistSnapshot();
          menu.hide();
        };
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "fn-menu__item fn-menu__item--danger";
        remove.textContent = "删除标签";
        remove.onclick = () => {
          metadata = {
            ...metadata,
            tags: metadata.tags.filter((item) => item.id !== tag.id),
            annotations: metadata.annotations.filter((annotation) => annotation.tagId !== tag.id),
          };
          editor.withView((view) => {
            let tr = view.state.tr;
            view.state.doc.descendants((node, pos) => {
              if (!node.isText) return;
              for (const mark of node.marks.filter((item) => item.type.name === "floatnote_annotation" && item.attrs.tagId === tag.id)) {
                tr = tr.removeMark(pos, pos + node.nodeSize, mark);
              }
            });
            if (tr.steps.length) view.dispatch(tr);
          });
          if (activeTag === tag.id) setFilter(null);
          persistSnapshot();
          menu.hide();
        };
        menu.showAt(event.clientX, event.clientY, [rename, remove]);
      };
      discs.append(button);
    }
    refreshProjection();
  }

  editor.contentDOM.addEventListener("contextmenu", (event) => {
    editor.withView((view) => {
      const { from, to, empty } = view.state.selection;
      const annotationType = view.state.schema.marks.floatnote_annotation;
      if (!annotationType) return;
      const menu = createMenu();
      const close = () => menu.hide();
      const items: HTMLElement[] = [];
      if (!empty) {
        for (const tag of metadata.tags) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "fn-menu__item annotation-menu-tag";
          button.style.setProperty("--c", tag.color);
          const dot = document.createElement("span");
          dot.className = "annotation-menu-dot";
          dot.setAttribute("aria-hidden", "true");
          const label = document.createElement("span");
          label.textContent = tag.name;
          button.append(dot, label);
          button.onclick = () => {
            view.dispatch(view.state.tr.addMark(from, to, annotationType.create({
              id: annotationId(), tagId: tag.id, color: tag.color, name: tag.name,
            })));
            close();
          };
          items.push(button);
        }
        items.push(newTagLauncher(view, from, to, annotationType, close));
      }
      const selectedAnnotations = annotationMarksAtSelection(view, annotationType);
      for (const annotation of selectedAnnotations) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "fn-menu__item fn-menu__item--danger annotation-menu-remove";
        remove.textContent = `移除「${annotation.attrs.name}」标注`;
        remove.onclick = () => {
          removeAnnotationMark(view, annotationType, annotation.attrs.id);
          close();
        };
        items.push(remove);
      }
      if (items.length === 0) {
        showToast("请先选择要标注的文本");
        return;
      }
      event.preventDefault();
      menu.showAt(event.clientX, event.clientY, items);
    });
  });

  void listen<QuotePayload>("quote-captured", (event) => {
    if (readOnly) return void showToast("Inbox metadata 已损坏，修复原文件后才能继续采集");
    const body = (event.payload.html && htmlToMarkdown(event.payload.html)) || event.payload.text;
    const oldMarkdown = editor.getMarkdown();
    const liveCaret = editor.withView((view) => editor.markdownOffsetAt(view.state.selection.from));
    const caret = Math.max(0, Math.min(liveCaret ?? lastCaretMarkdownOffset, oldMarkdown.length));
    const currentAnnotations = editor.withView((view) => annotationsFromMarks(view, oldMarkdown));
    const target = resolveMergeTarget(oldMarkdown, caret, event.payload.source, metadata.quoteSources);
    let change: { from: number; to: number; insert: string };
    let nextQuoteSources = metadata.quoteSources;
    if (target.kind === "merge") {
      change = buildQuoteAppendChange(
        oldMarkdown.slice(target.range.from, target.range.to),
        target.range.from,
        target.range.to,
        body,
      );
    } else {
      const block = buildQuoteBlock(body, event.payload.source);
      const insert = buildCaretInsert(oldMarkdown.slice(0, target.at), oldMarkdown.slice(target.at), block);
      change = { from: target.at, to: target.at, insert };
      if (event.payload.source?.bundleId) {
        nextQuoteSources = [...nextQuoteSources, {
          cardFrom: target.at + insert.indexOf(block),
          bundleId: event.payload.source.bundleId,
        }];
      }
    }
    const nextMarkdown = `${oldMarkdown.slice(0, change.from)}${change.insert}${oldMarkdown.slice(change.to)}`;
    const insertedAt = change.from + Math.max(0, change.insert.indexOf("[!quote]"));
    const targetCardIndex = quoteCardRanges(nextMarkdown).findIndex((range) => (
      range.from <= insertedAt && insertedAt <= range.to
    ));
    metadata = {
      ...metadata,
      annotations: mapAnnotations(currentAnnotations, [change]),
      quoteSources: mapQuoteSources(oldMarkdown, nextMarkdown, nextQuoteSources, [change]),
    };
    loading = true;
    try {
      editor.replace(nextMarkdown, { addToHistory: true });
      editor.withView((view) => applyMetadataMarks(view, nextMarkdown, metadata));
      editor.withView((view) => applyQuoteSources(view, nextMarkdown, metadata));
      if (targetCardIndex >= 0) {
        const structuralEnd = editor.withView((view) => {
          let index = 0;
          let end: number | null = null;
          view.state.doc.descendants((node, pos) => {
            if (node.type.name !== "quote_card") return;
            if (index === targetCardIndex) end = pos + node.nodeSize - 1;
            index += 1;
          });
          return end;
        });
        if (structuralEnd !== null) editor.setSelection(structuralEnd);
      }
    } finally {
      loading = false;
    }
    options.onSave(encodeInbox(nextMarkdown, metadata));
    lastCaretMarkdownOffset = editor.withView((view) => editor.markdownOffsetAt(view.state.selection.from))
      ?? change.from + change.insert.length;
    editor.focus();
    refresh();
  });

  loading = false;
  refresh();
  return {
    editor,
    tagBar,
    metadata: () => metadata,
    load(markdown, nextMetadata) {
      loading = true;
      try {
        metadata = structuredClone(nextMetadata);
        editor.load(markdown);
        if (activeTag && !metadata.tags.some((tag) => tag.id === activeTag)) activeTag = null;
        syncFilterVisibility();
        editor.withView((view) => applyMetadataMarks(view, markdown, metadata));
        editor.withView((view) => applyQuoteSources(view, markdown, metadata));
        lastCaretMarkdownOffset = editor.withView((view) => editor.markdownOffsetAt(view.state.selection.from)) ?? 0;
      } finally {
        loading = false;
      }
      refresh();
    },
    snapshot: () => encodeInbox(editor.getMarkdown(), {
      ...metadata,
      annotations: editor.withView((view) => annotationsFromMarks(view, editor.getMarkdown())),
      quoteSources: editor.withView((view) => quoteSourcesFromNodes(view, editor.getMarkdown())),
    }),
    setFilter,
    setReadOnly(value) {
      readOnly = value;
      editor.setReadOnly(value);
    },
    refresh,
  };
}

export {
  alignTextNodes,
  annotationsFromMarks,
  applyMetadataMarks,
  applyQuoteSources,
  quoteSourcesFromNodes,
};
