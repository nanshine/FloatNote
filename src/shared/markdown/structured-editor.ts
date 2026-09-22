import "katex/dist/katex.min.css";
import "./structured-editor.css";
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  parserCtx,
  rootAttrsCtx,
  rootCtx,
  rootDOMCtx,
  serializerCtx,
} from "@milkdown/kit/core";
import { history } from "@milkdown/kit/plugin/history";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { Slice, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { EditorState, Plugin, Selection as ProseSelection, TextSelection, type Selection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { floatnoteEditorRuntime, floatnoteMarkdownPlugins, handleListParentEnter } from "./milkdown-plugins";
import { guardNoteHorizontalScroll } from "./note-scroll";
import { openUrl } from "../../platform/open-url";
import { isSafeUrl } from "./safe-url";
import { bareLinkInputRule, linkPastePlugin, markdownLinkInputRule, undoLinkInput } from "./link-input";
import { createLinkEditor } from "./link-editor";

export type MarkdownDocumentKind = "inbox" | "piece" | "document" | "composer";

export interface StructuredEditorContext {
  readonly kind: MarkdownDocumentKind;
  resolveImageSrc?: (url: string) => string;
}

export interface StructuredEditorCheckpoint {
  readonly state: EditorState;
}

export interface StructuredMarkdownEditorOptions {
  parent: HTMLElement;
  markdown?: string;
  context: StructuredEditorContext;
  placeholder?: string;
  className?: string;
  onChange?: (markdown: string) => void;
  onFocus?: () => void;
  onSelectionChange?: (selection: Selection) => void;
  handleKeyDown?: (event: KeyboardEvent, editor: StructuredMarkdownEditor) => boolean;
}

export interface StructuredMarkdownEditor {
  readonly element: HTMLElement;
  readonly contentDOM: HTMLElement;
  readonly context: StructuredEditorContext;
  load(markdown: string, context?: { resolveImageSrc?: (url: string) => string }): void;
  replace(markdown: string, options?: { addToHistory?: boolean }): void;
  getMarkdown(): string;
  checkpoint(): StructuredEditorCheckpoint;
  restore(checkpoint: StructuredEditorCheckpoint): void;
  setReadOnly(readOnly: boolean): void;
  focus(): void;
  setSelection(anchor: number, head?: number): void;
  /** Map a structural document position into this editor's canonical Markdown. */
  markdownOffsetAt(position: number): number | null;
  /** Editor-integration escape hatch. Feature UI must expose domain commands instead of leaking this view further. */
  withView<T>(run: (view: EditorView) => T): T;
  destroy(): Promise<void>;
}

export function markdownLinkOpenHint(platform = navigator.platform): string {
  return /Mac/i.test(platform) ? "按住 ⌘ 并点击以打开链接" : "按住 Ctrl 并点击以打开链接";
}

export function shouldOpenMarkdownLink(event: Pick<MouseEvent, "metaKey" | "ctrlKey">, platform = navigator.platform): boolean {
  return /Mac/i.test(platform) ? event.metaKey : event.ctrlKey;
}

function usesNoteSurface(kind: MarkdownDocumentKind): boolean {
  return kind === "inbox" || kind === "piece" || kind === "document";
}

function createPlaceholderPlugin(placeholder: string) {
  return $prose(() => new Plugin({
    props: {
      decorations(state) {
        const paragraph = state.doc.firstChild;
        if (
          state.doc.childCount !== 1
          || paragraph?.type.name !== "paragraph"
          || paragraph.content.size !== 0
        ) return DecorationSet.empty;
        return DecorationSet.create(state.doc, [Decoration.node(0, paragraph.nodeSize, {
          class: "fn-empty-paragraph",
          "data-placeholder": placeholder,
        })]);
      },
    },
  }));
}

function replaceDocument(view: EditorView, markdown: string, parse: (markdown: string) => ProseNode, addToHistory: boolean): void {
  const doc = parse(markdown);
  if (!doc) return;
  const transaction = view.state.tr.replace(
    0,
    view.state.doc.content.size,
    new Slice(doc.content, 0, 0),
  );
  transaction.setMeta("addToHistory", addToHistory);
  view.dispatch(transaction);
}

function normalizeFloatNoteMarkdown(markdown: string): string {
  return markdown.replace(/^(>\s*)\\\[!quote\]/gim, "$1[!quote]");
}

export async function createStructuredMarkdownEditor(
  options: StructuredMarkdownEditorOptions,
): Promise<StructuredMarkdownEditor> {
  const context = { ...options.context };
  const noteSurface = usesNoteSurface(context.kind);
  const rootClasses = [
    "milkdown",
    "fn-structured-editor",
    noteSurface ? "fn-note-structured-editor" : "",
    options.className ?? "",
  ].filter(Boolean).join(" ");
  let suppressChange = true;
  let readOnly = false;
  let api!: StructuredMarkdownEditor;

  const milkdown = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, options.parent);
      ctx.set(rootAttrsCtx, {
        class: rootClasses,
        ...(options.placeholder ? { "data-placeholder": options.placeholder } : {}),
      });
      ctx.set(defaultValueCtx, options.markdown ?? "");
      ctx.set(floatnoteEditorRuntime.key, {
        resolveImageSrc: (url) => context.resolveImageSrc?.(url) ?? url,
      });
    })
    .use(commonmark)
    .use(gfm)
    .use(history);
  if (options.placeholder) milkdown.use(createPlaceholderPlugin(options.placeholder));
  milkdown.use(floatnoteMarkdownPlugins);
  milkdown.use([markdownLinkInputRule, bareLinkInputRule, linkPastePlugin]);

  await milkdown.create();
  const view = milkdown.ctx.get(editorViewCtx);
  const parser = milkdown.ctx.get(parserCtx);
  const serializer = milkdown.ctx.get(serializerCtx);
  const linkEditor = createLinkEditor(view);
  const currentRoot = () => milkdown.ctx.get(rootDOMCtx);
  const noteScroll = noteSurface ? guardNoteHorizontalScroll(view.dom) : undefined;
  if (options.placeholder) {
    view.dom.dataset.placeholder = options.placeholder;
  }

  view.setProps({
    editable: () => !readOnly,
    dispatchTransaction(transaction) {
      const previousSelection = view.state.selection;
      const nextState = view.state.apply(transaction);
      view.updateState(nextState);
      noteScroll?.reset();
      if (transaction.docChanged && !suppressChange) options.onChange?.(normalizeFloatNoteMarkdown(serializer(nextState.doc)));
      if (!nextState.selection.eq(previousSelection)) options.onSelectionChange?.(nextState.selection);
    },
    handleKeyDown: (currentView, event) => linkEditor.handleKeyDown(event)
      || undoLinkInput(currentView, event)
      || options.handleKeyDown?.(event, api)
      || handleListParentEnter(currentView, event),
  });
  view.dom.addEventListener("focusin", () => options.onFocus?.());
  const openMarkdownLink = (event: MouseEvent) => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>("a[href]")
      : null;
    if (!target || !view.dom.contains(target)) return;
    const url = target.getAttribute("href") ?? "";
    event.preventDefault();
    if (!isSafeUrl(url) || !/^(https?:\/\/|mailto:)/i.test(url)) return;
    if (!shouldOpenMarkdownLink(event)) return;
    event.stopPropagation();
    void openUrl(url).catch(() => undefined);
  };
  const linkHint = document.createElement("div");
  linkHint.className = "fn-markdown-link-hint";
  linkHint.setAttribute("role", "tooltip");
  linkHint.textContent = markdownLinkOpenHint();
  let hoveredLink: HTMLAnchorElement | null = null;
  const hideLinkHint = () => {
    hoveredLink?.classList.remove("fn-markdown-link-ready");
    hoveredLink = null;
    linkHint.remove();
  };
  const updateLinkModifier = (event: Pick<MouseEvent, "metaKey" | "ctrlKey">) => {
    hoveredLink?.classList.toggle("fn-markdown-link-ready", shouldOpenMarkdownLink(event));
  };
  const describeMarkdownLink = (event: MouseEvent) => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>("a[href]")
      : null;
    const url = target?.getAttribute("href") ?? "";
    if (!target || !view.dom.contains(target)
      || !isSafeUrl(url) || !/^(https?:\/\/|mailto:)/i.test(url)) {
      hideLinkHint();
      return;
    }
    if (hoveredLink !== target) {
      hideLinkHint();
      hoveredLink = target;
    }
    updateLinkModifier(event);
    linkHint.textContent = `${url} · ${markdownLinkOpenHint()} · ${/Mac/i.test(navigator.platform) ? "⌘K" : "Ctrl+K"} 编辑`;
    document.body.append(linkHint);
    const rect = target.getBoundingClientRect();
    const hintRect = linkHint.getBoundingClientRect();
    linkHint.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - hintRect.width - 8))}px`;
    linkHint.style.top = `${Math.max(8, rect.bottom + hintRect.height + 8 > window.innerHeight
      ? rect.top - hintRect.height - 6 : rect.bottom + 6)}px`;
  };
  view.dom.addEventListener("click", openMarkdownLink);
  view.dom.addEventListener("mouseover", describeMarkdownLink);
  view.dom.addEventListener("mousemove", describeMarkdownLink);
  view.dom.addEventListener("mouseleave", hideLinkHint);
  window.addEventListener("keydown", updateLinkModifier, true);
  window.addEventListener("keyup", updateLinkModifier, true);
  window.addEventListener("blur", hideLinkHint);
  window.addEventListener("scroll", hideLinkHint, true);

  // The visual note surface can be taller than its document. When a click lands
  // on host whitespace instead of the contenteditable node, focus the same
  // editor at its logical end; an empty document therefore always resolves to
  // its first paragraph. Filter projections and read-only previews opt out.
  const focusFromHostWhitespace = (event: PointerEvent) => {
    const root = currentRoot();
    if (readOnly || root.hidden || event.button !== 0) return;
    if (event.target !== options.parent && event.target !== root) return;
    event.preventDefault();
    view.focus();
    view.dispatch(view.state.tr.setSelection(ProseSelection.atEnd(view.state.doc)));
  };
  if (noteSurface) {
    options.parent.addEventListener("pointerdown", focusFromHostWhitespace);
  }

  api = {
    get element() { return currentRoot(); },
    contentDOM: view.dom,
    context,
    load(markdown, nextContext) {
      linkEditor.close();
      Object.assign(context, nextContext ?? {});
      const doc = parser(markdown);
      if (!doc) return;
      suppressChange = true;
      try {
        view.updateState(EditorState.create({
          schema: view.state.schema,
          doc,
          plugins: view.state.plugins,
        }));
      } finally {
        suppressChange = false;
      }
    },
    replace(markdown, replaceOptions = {}) {
      linkEditor.close();
      suppressChange = true;
      try {
        replaceDocument(view, markdown, parser, replaceOptions.addToHistory ?? true);
      } finally {
        suppressChange = false;
      }
    },
    getMarkdown: () => normalizeFloatNoteMarkdown(serializer(view.state.doc)),
    checkpoint: () => ({ state: view.state }),
    restore(checkpoint) {
      linkEditor.close();
      suppressChange = true;
      try {
        view.updateState(checkpoint.state);
      } finally {
        suppressChange = false;
      }
    },
    setReadOnly(value) {
      if (value) linkEditor.close();
      readOnly = value;
      view.setProps({ editable: () => !readOnly });
      currentRoot().classList.toggle("fn-structured-editor--readonly", readOnly);
    },
    focus: () => view.focus(),
    setSelection(anchor, head = anchor) {
      const max = view.state.doc.content.size;
      const safeAnchor = Math.max(0, Math.min(anchor, max));
      const safeHead = Math.max(0, Math.min(head, max));
      const selection = safeAnchor === safeHead
        ? ProseSelection.near(view.state.doc.resolve(safeAnchor))
        : TextSelection.between(view.state.doc.resolve(safeAnchor), view.state.doc.resolve(safeHead));
      view.dispatch(view.state.tr.setSelection(selection));
    },
    markdownOffsetAt(position) {
      const max = view.state.doc.content.size;
      const safePosition = Math.max(0, Math.min(position, max));
      let marker = `FLOATNOTECARETMARKER${Date.now().toString(36).toUpperCase()}`;
      while (view.state.doc.textContent.includes(marker)) marker += "Z";
      const transaction = view.state.tr.insertText(marker, safePosition, safePosition);
      if (!transaction.docChanged) return null;
      const marked = normalizeFloatNoteMarkdown(serializer(transaction.doc));
      const offset = marked.indexOf(marker);
      return offset < 0 ? null : offset;
    },
    withView: (run) => run(view),
    async destroy() {
      linkEditor.destroy();
      noteScroll?.destroy();
      view.dom.removeEventListener("click", openMarkdownLink);
      view.dom.removeEventListener("mouseover", describeMarkdownLink);
      view.dom.removeEventListener("mousemove", describeMarkdownLink);
      view.dom.removeEventListener("mouseleave", hideLinkHint);
      window.removeEventListener("keydown", updateLinkModifier, true);
      window.removeEventListener("keyup", updateLinkModifier, true);
      window.removeEventListener("blur", hideLinkHint);
      window.removeEventListener("scroll", hideLinkHint, true);
      hideLinkHint();
      options.parent.removeEventListener("pointerdown", focusFromHostWhitespace);
      await milkdown.destroy();
    },
  };

  suppressChange = false;
  return api;
}
