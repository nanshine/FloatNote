import katex from "katex";
import remarkMath from "remark-math";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { InputRule, wrappingInputRule } from "@milkdown/kit/prose/inputrules";
import type { NodeViewConstructor } from "@milkdown/kit/prose/view";
import { Fragment } from "@milkdown/kit/prose/model";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { blockquoteSchema, codeBlockSchema, hrSchema, imageSchema, linkSchema, listItemSchema } from "@milkdown/kit/preset/commonmark";
import { Compartment, EditorState as CodeState } from "@codemirror/state";
import { EditorView as CodeView, keymap as codeKeymap } from "@codemirror/view";
import { defaultKeymap, history as codeHistory, historyKeymap } from "@codemirror/commands";
import { LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { addColumnAfter, addRowAfter, deleteColumn, deleteRow } from "@milkdown/kit/prose/tables";
import { $ctx, $inputRule, $markSchema, $nodeSchema, $prose, $remark, $view } from "@milkdown/kit/utils";
import { isSafeUrl } from "./safe-url";
import type { Root as MdastRoot } from "mdast";
import { floatnoteCodeHighlight, floatnoteCodeLanguages } from "./code-languages";
import { wireOpenUrlLink } from "../../platform/open-url";

export const floatnoteRemarkMath = $remark("floatnoteRemarkMath", () => remarkMath);

function remarkQuoteCards() {
  return (tree: MdastRoot) => {
    const walk = (node: { type: string; children?: { type: string; children?: unknown[]; value?: string }[] }) => {
      for (const child of node.children ?? []) {
        if (child.type === "blockquote") {
          const paragraph = child.children?.[0] as { type?: string; children?: { type?: string; value?: string }[] } | undefined;
          const first = paragraph?.type === "paragraph" ? paragraph.children?.[0] : undefined;
          if (first?.type === "text" && /^\[!quote\](?:\s|$)/i.test(first.value ?? "")) {
            child.type = "floatnoteQuoteCard";
          }
        }
        if (child.children) walk(child as { type: string; children: { type: string; children?: unknown[]; value?: string }[] });
      }
    };
    walk(tree as unknown as { type: string; children: { type: string; children?: unknown[]; value?: string }[] });
  };
}

export const floatnoteRemarkQuoteCards = $remark("floatnoteRemarkQuoteCards", () => remarkQuoteCards);

function remarkImageAttributes() {
  return (tree: MdastRoot) => {
    const walk = (node: { children?: { type: string; value?: string; data?: Record<string, unknown>; children?: unknown[] }[] }) => {
      const children = node.children ?? [];
      for (let index = 0; index < children.length; index += 1) {
        const image = children[index];
        const suffix = children[index + 1];
        if (image.type === "image" && suffix?.type === "text") {
          const match = /^\{([^}]*)\}/.exec(suffix.value ?? "");
          if (match) {
            const width = /\bwidth\s*=\s*(\d+)/.exec(match[1])?.[1];
            const align = /\.(left|center|right)\b/.exec(match[1])?.[1];
            image.data = { ...image.data, floatnoteWidth: width ? Number(width) : null, floatnoteAlign: align ?? null };
            suffix.value = (suffix.value ?? "").slice(match[0].length);
            if (!suffix.value) children.splice(index + 1, 1);
          }
        }
        if (image.children) walk(image as { children: { type: string; value?: string; data?: Record<string, unknown>; children?: unknown[] }[] });
      }
    };
    walk(tree as unknown as { children: { type: string; value?: string; data?: Record<string, unknown>; children?: unknown[] }[] });
  };
}

export const floatnoteRemarkImageAttributes = $remark("floatnoteRemarkImageAttributes", () => remarkImageAttributes);

export interface FloatNoteEditorRuntime {
  resolveImageSrc: (url: string) => string;
}

export const floatnoteEditorRuntime = $ctx({
  resolveImageSrc: (url) => safeMarkdownUrl(url),
} satisfies FloatNoteEditorRuntime, "floatnoteEditorRuntime");

export const inlineMathSchema = $nodeSchema("inline_math", () => ({
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  attrs: { latex: { default: "", validate: "string" } },
  parseDOM: [{
    tag: "span[data-fn-inline-math]",
    getAttrs: (dom) => ({ latex: (dom as HTMLElement).dataset.latex ?? "" }),
  }],
  toDOM: (node) => ["span", {
    "data-fn-inline-math": "",
    "data-latex": node.attrs.latex,
    class: "fn-structured-math fn-structured-math--inline",
  }],
  parseMarkdown: {
    match: (node) => node.type === "inlineMath",
    runner: (state, node, type) => state.addNode(type, { latex: String(node.value ?? "") }),
  },
  toMarkdown: {
    match: (node) => node.type.name === "inline_math",
    runner: (state, node) => state.addNode("inlineMath", undefined, String(node.attrs.latex ?? "")),
  },
}));

export const blockMathSchema = $nodeSchema("block_math", () => ({
  group: "block",
  atom: true,
  selectable: true,
  defining: true,
  attrs: { latex: { default: "", validate: "string" } },
  parseDOM: [{
    tag: "div[data-fn-block-math]",
    getAttrs: (dom) => ({ latex: (dom as HTMLElement).dataset.latex ?? "" }),
  }],
  toDOM: (node) => ["div", {
    "data-fn-block-math": "",
    "data-latex": node.attrs.latex,
    class: "fn-structured-math fn-structured-math--block",
  }],
  parseMarkdown: {
    match: (node) => node.type === "math",
    runner: (state, node, type) => state.addNode(type, { latex: String(node.value ?? "") }),
  },
  toMarkdown: {
    match: (node) => node.type.name === "block_math",
    runner: (state, node) => state.addNode("math", undefined, String(node.attrs.latex ?? "")),
  },
}));

/** Inbox-only semantic mark. It is deliberately omitted from Markdown output;
 * the Inbox codec serializes it back to FloatNote v2 comment metadata. */
export const annotationMarkSchema = $markSchema("floatnote_annotation", () => ({
  inclusive: false,
  excludes: "",
  attrs: {
    id: { default: "", validate: "string" },
    tagId: { default: "", validate: "string" },
    color: { default: "", validate: "string" },
    name: { default: "", validate: "string" },
  },
  parseDOM: [{
    tag: "span[data-fn-annotation]",
    getAttrs: (dom) => {
      const element = dom as HTMLElement;
      return {
        id: element.dataset.annotationId ?? "",
        tagId: element.dataset.tagId ?? "",
        color: element.dataset.color ?? "",
        name: element.dataset.name ?? "",
      };
    },
  }],
  toDOM: (mark) => ["span", {
    "data-fn-annotation": "",
    "data-annotation-id": mark.attrs.id,
    "data-tag-id": mark.attrs.tagId,
    "data-color": mark.attrs.color,
    "data-name": mark.attrs.name,
    "aria-label": `已标注：${mark.attrs.name}`,
    class: "fn-inline-annotation",
    style: `--annotation-color:${mark.attrs.color}`,
  }, 0],
  parseMarkdown: {
    match: () => false,
    runner: () => undefined,
  },
  toMarkdown: {
    match: (mark) => mark.type.name === "floatnote_annotation",
    runner: () => undefined,
  },
}));

export const assistantRefSchema = $nodeSchema("assistant_ref", () => ({
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  attrs: {
    kind: { default: "file", validate: "string" },
    id: { default: "", validate: "string" },
    display: { default: "", validate: "string" },
    noteKind: { default: null, validate: "string|null" },
  },
  parseDOM: [{
    tag: "span[data-assistant-ref]",
    getAttrs: (dom) => ({ ...(dom as HTMLElement).dataset }),
  }],
  toDOM: (node) => ["span", {
    "data-assistant-ref": "",
    class: "fn-ref-chip",
    title: node.attrs.display,
  }, node.attrs.display],
  parseMarkdown: { match: () => false, runner: () => undefined },
  toMarkdown: { match: (node) => node.type.name === "assistant_ref", runner: () => undefined },
}));

export const floatnoteImageSchema = imageSchema.extendSchema((previous) => (ctx) => {
  const base = previous(ctx);
  return {
    ...base,
    attrs: {
      ...base.attrs,
      width: { default: null, validate: "number|null" },
      align: { default: null, validate: "string|null" },
    },
    parseMarkdown: {
      match: (node) => node.type === "image",
      runner: (state, node, type) => {
        const data = node.data as { floatnoteWidth?: unknown; floatnoteAlign?: unknown } | undefined;
        state.addNode(type, {
          src: String(node.url ?? ""),
          alt: String(node.alt ?? ""),
          title: String(node.title ?? ""),
          width: typeof data?.floatnoteWidth === "number" ? data.floatnoteWidth : null,
          align: typeof data?.floatnoteAlign === "string" ? data.floatnoteAlign : null,
        });
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === "image",
      runner: (state, node) => {
        state.addNode("image", undefined, undefined, {
          title: node.attrs.title,
          url: node.attrs.src,
          alt: node.attrs.alt,
        });
        const parts = [
          node.attrs.width != null ? `width=${node.attrs.width}` : "",
          node.attrs.align ? `.${node.attrs.align}` : "",
        ].filter(Boolean);
        if (parts.length) state.addNode("text", undefined, `{${parts.join(" ")}}`);
      },
    },
  };
});

export const floatnoteLinkSchema = linkSchema.extendSchema((previous) => (ctx) => {
  const base = previous(ctx);
  return {
    ...base,
    toDOM: (mark) => ["a", {
      href: safeMarkdownUrl(String(mark.attrs.href ?? "")),
      title: mark.attrs.title || null,
      rel: "noreferrer noopener",
    }, 0],
  };
});

export const quoteCardSchema = $nodeSchema("quote_card", () => ({
  content: "block+",
  group: "block",
  defining: true,
  attrs: {
    bundleId: { default: null, validate: "string|null" },
  },
  parseDOM: [{ tag: "aside[data-fn-quote-card]" }],
  toDOM: () => ["aside", { "data-fn-quote-card": "", class: "fn-quote-card" }, 0],
  parseMarkdown: {
    match: (node) => node.type === "floatnoteQuoteCard",
    runner: (state, node, type) => state.openNode(type).next(node.children).closeNode(),
  },
  toMarkdown: {
    match: (node) => node.type.name === "quote_card",
    runner: (state, node) => state.openNode("blockquote").next(node.content).closeNode(),
  },
}));

function mathView(displayMode: boolean): NodeViewConstructor {
  return (initialNode, view, getPos) => {
    let node = initialNode;
    const dom = document.createElement(displayMode ? "div" : "span");
    dom.className = displayMode
      ? "fn-structured-math fn-structured-math--block"
      : "fn-structured-math fn-structured-math--inline";
    dom.contentEditable = "false";
    const rendered = document.createElement(displayMode ? "div" : "span");
    rendered.className = "fn-structured-math__rendered";
    const input = document.createElement("textarea");
    input.className = "fn-structured-math__input";
    input.setAttribute("aria-label", displayMode ? "编辑块公式" : "编辑行内公式");
    input.title = displayMode ? "Cmd/Ctrl+Enter 完成" : "Enter 完成";
    input.rows = displayMode ? 3 : 1;
    input.hidden = true;
    dom.append(rendered, input);

    const render = () => {
      const latex = String(node.attrs.latex ?? "");
      dom.dataset.latex = latex;
      input.value = latex;
      try {
        rendered.innerHTML = katex.renderToString(latex, {
          displayMode,
          throwOnError: true,
          trust: false,
          strict: "ignore",
          maxExpand: 1_000,
          maxSize: 20,
          output: "htmlAndMathml",
        });
        rendered.classList.remove("fn-math-error");
      } catch {
        rendered.textContent = `${displayMode ? "$$" : "$"}${latex}${displayMode ? "$$" : "$"}`;
        rendered.classList.add("fn-math-error");
      }
    };

    const commit = () => {
      input.hidden = true;
      rendered.hidden = false;
      if (!view.editable) return;
      const pos = getPos();
      if (pos === undefined) return;
      view.dispatch(view.state.tr.setNodeAttribute(pos, "latex", input.value));
    };
    rendered.addEventListener("click", () => {
      if (!view.editable) return;
      rendered.hidden = true;
      input.hidden = false;
      input.focus();
      input.select();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        input.value = String(node.attrs.latex ?? "");
        input.hidden = true;
        rendered.hidden = false;
      } else if (event.key === "Enter" && (!displayMode || event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        commit();
      }
    });
    input.addEventListener("blur", commit);
    render();

    return {
      dom,
      update(updated) {
        if (updated.type !== node.type) return false;
        node = updated;
        render();
        return true;
      },
      stopEvent: (event) => event.target === input,
      ignoreMutation: () => true,
    };
  };
}

export const inlineMathView = $view(inlineMathSchema.node, () => mathView(false));
export const blockMathView = $view(blockMathSchema.node, () => mathView(true));

const blockHandleIcon = '<svg viewBox="0 0 12 16" aria-hidden="true"><circle cx="4" cy="4" r="1"/><circle cx="8" cy="4" r="1"/><circle cx="4" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="8" cy="12" r="1"/></svg>';

function createBlockHandle(label: string): HTMLButtonElement {
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "fn-structured-block-handle";
  handle.contentEditable = "false";
  handle.tabIndex = -1;
  handle.setAttribute("aria-label", label);
  handle.title = `${label}，Delete/Backspace 删除`;
  handle.innerHTML = blockHandleIcon;
  return handle;
}

function selectNodeFromPointer(
  event: MouseEvent,
  view: Parameters<NodeViewConstructor>[1],
  getPos: Parameters<NodeViewConstructor>[2],
): void {
  if (!view.editable || event.button !== 0) return;
  const pos = getPos();
  if (pos === undefined) return;
  event.preventDefault();
  event.stopPropagation();
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
  view.focus();
}

export const blockquoteView = $view(blockquoteSchema.node, (): NodeViewConstructor => {
  return (_node, view, getPos) => {
    const dom = document.createElement("blockquote");
    const handle = createBlockHandle("选择整段引用");
    const contentDOM = document.createElement("div");
    contentDOM.className = "fn-structured-block-content";
    dom.append(handle, contentDOM);
    handle.addEventListener("mousedown", (event) => selectNodeFromPointer(event, view, getPos));
    dom.addEventListener("mousedown", (event) => {
      if (event.target === dom) selectNodeFromPointer(event, view, getPos);
    });
    return {
      dom,
      contentDOM,
      selectNode: () => dom.classList.add("is-block-selected"),
      deselectNode: () => dom.classList.remove("is-block-selected"),
      stopEvent: (event) => event.target === handle,
    };
  };
});

export const dividerView = $view(hrSchema.node, (): NodeViewConstructor => {
  return (_node, view, getPos) => {
    const dom = document.createElement("div");
    dom.className = "fn-structured-divider";
    dom.contentEditable = "false";
    dom.setAttribute("role", "separator");
    dom.setAttribute("aria-label", "分隔线；点击选择，Delete 或 Backspace 删除");
    const line = document.createElement("hr");
    dom.append(line);
    dom.addEventListener("mousedown", (event) => selectNodeFromPointer(event, view, getPos));
    return {
      dom,
      selectNode: () => dom.classList.add("is-block-selected"),
      deselectNode: () => dom.classList.remove("is-block-selected"),
      stopEvent: () => true,
      ignoreMutation: () => true,
    };
  };
});

export const quoteCardView = $view(quoteCardSchema.node, (): NodeViewConstructor => {
  return (initialNode, view, getPos) => {
    let node = initialNode;
    let selected = false;
    let editing = false;
    const dom = document.createElement("aside");
    dom.className = "fn-quote-card";
    dom.dataset.fnQuoteCard = "";
    const header = document.createElement("div");
    header.className = "fn-quote-card__header";
    header.contentEditable = "false";
    const icon = document.createElement("span");
    icon.className = "fn-quote-card__icon";
    icon.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 4.2h3.5v3.2H4.9c0 1.7.6 2.8 1.8 3.6l-1.2 1.2C3.8 11.1 3 9.4 3 7.2c0-1.1.1-2.1.2-3Zm6.1 0h3.5v3.2H11c0 1.7.6 2.8 1.8 3.6l-1.2 1.2C9.9 11.1 9.1 9.4 9.1 7.2c0-1.1.1-2.1.2-3Z" fill="currentColor"/></svg>';
    const source = document.createElement("span");
    source.className = "fn-quote-card__source";
    const sourceEditor = document.createElement("span");
    sourceEditor.className = "fn-quote-card__source-editor";
    const labelInput = document.createElement("input");
    labelInput.className = "fn-quote-card__source-input fn-quote-card__source-input--label";
    labelInput.placeholder = "来源名称";
    labelInput.setAttribute("aria-label", "引用来源名称");
    const urlInput = document.createElement("input");
    urlInput.className = "fn-quote-card__source-input fn-quote-card__source-input--url";
    urlInput.placeholder = "https://…";
    urlInput.inputMode = "url";
    urlInput.setAttribute("aria-label", "引用来源链接");
    const clearSource = document.createElement("button");
    clearSource.type = "button";
    clearSource.className = "fn-quote-card__source-action";
    clearSource.setAttribute("aria-label", "移除引用来源");
    clearSource.title = "移除引用来源";
    clearSource.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>';
    const editSource = document.createElement("button");
    editSource.type = "button";
    editSource.className = "fn-quote-card__source-action fn-quote-card__edit";
    editSource.setAttribute("aria-label", "编辑引用来源");
    editSource.title = "编辑引用来源";
    editSource.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m10 3 3 3-7.5 7.5H2.5v-3L10 3Zm-1.5 1.5 3 3" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/></svg>';
    const saveSource = document.createElement("button");
    saveSource.type = "button";
    saveSource.className = "fn-quote-card__source-action";
    saveSource.setAttribute("aria-label", "保存引用来源");
    saveSource.title = "保存引用来源（Enter）；Esc 取消";
    saveSource.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    sourceEditor.append(labelInput, urlInput, saveSource, clearSource);
    const contentDOM = document.createElement("div");
    contentDOM.className = "fn-quote-card__content";
    header.append(icon, source, editSource, sourceEditor);
    dom.append(header, contentDOM);

    const sourceValues = () => {
      const title = node.firstChild;
      const titleLine = title?.textContent.split("\n", 1)[0] ?? "";
      const label = titleLine.replace(/^\[!quote\]\s*/i, "").trim();
      let href = "";
      title?.descendants((child) => {
        const link = child.marks.find((mark) => mark.type.name === "link");
        if (!href && link && label.includes(child.textContent.trim())) href = safeMarkdownUrl(String(link.attrs.href ?? ""));
      });
      return { label, href };
    };

    const commitSource = () => {
      if (!view.editable) return;
      const pos = getPos();
      if (pos === undefined) return;
      const liveNode = view.state.doc.nodeAt(pos);
      const title = liveNode?.firstChild;
      if (!liveNode || !title) return;
      const label = labelInput.value.trim();
      const href = safeMarkdownUrl(urlInput.value.trim());
      const children = [view.state.schema.text("[!quote]")];
      if (label) {
        const link = href ? view.state.schema.marks.link?.create({ href, title: null }) : null;
        children.push(view.state.schema.text(` ${label}`, link ? [link] : undefined));
      }
      const lineEnd = title.textContent.indexOf("\n");
      if (lineEnd >= 0) {
        // Consecutive Markdown quote lines are represented by one paragraph.
        // Replace only the hidden source line, otherwise editing the source
        // would also delete the visible quote text after its newline.
        children.push(view.state.schema.text("\n"));
        view.dispatch(view.state.tr.replaceWith(
          pos + 2,
          pos + 2 + lineEnd + 1,
          Fragment.fromArray(children),
        ));
      } else {
        const nextTitle = title.type.create(title.attrs, children);
        view.dispatch(view.state.tr.replaceWith(pos + 1, pos + 1 + title.nodeSize, nextTitle));
      }
    };

    const syncSelection = () => {
      dom.classList.toggle("is-block-selected", selected);
      source.hidden = editing;
      sourceEditor.hidden = !editing;
      editSource.hidden = editing || !view.editable;
    };
    const render = () => {
      const { label, href } = sourceValues();
      source.replaceChildren();
      if (href) {
        const anchor = document.createElement("a");
        anchor.textContent = label || href;
        anchor.title = href;
        wireOpenUrlLink(anchor, href);
        source.append(anchor);
      } else {
        source.textContent = label || "引用";
      }
      source.classList.toggle("has-link", Boolean(href));
      if (!editing) {
        labelInput.value = label;
        urlInput.value = href;
      }
      clearSource.hidden = !label && !href;
      syncSelection();
    };
    header.addEventListener("mousedown", (event) => {
      if (!(event.target as Element).closest("input, button, a")) selectNodeFromPointer(event, view, getPos);
    });
    editSource.addEventListener("click", () => {
      if (!view.editable) return;
      editing = true;
      syncSelection();
      labelInput.focus();
      labelInput.select();
    });
    const finishEditing = (save: boolean) => {
      if (save) commitSource();
      editing = false;
      render();
      editSource.focus();
    };
    saveSource.addEventListener("click", () => finishEditing(true));
    sourceEditor.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finishEditing(event.key === "Enter");
      }
    });
    clearSource.addEventListener("click", () => {
      labelInput.value = "";
      urlInput.value = "";
      labelInput.focus();
    });
    render();
    return {
      dom,
      contentDOM,
      update(updated) {
        if (updated.type !== node.type) return false;
        node = updated;
        render();
        return true;
      },
      selectNode() {
        selected = true;
        syncSelection();
      },
      deselectNode() {
        selected = false;
        syncSelection();
      },
      stopEvent: (event) => header.contains(event.target as Node),
      ignoreMutation: (mutation) => mutation.type !== "selection" && header.contains(mutation.target),
    };
  };
});

export const inlineMathInputRule = $inputRule((ctx) => new InputRule(
  /(?:^|[^$])\$([^$\n]+)\$$/,
  (state, match, start, end) => {
    const latex = match[1];
    if (!latex) return null;
    const leading = match[0].startsWith("$") ? 0 : 1;
    return state.tr.replaceWith(
      start + leading,
      end,
      inlineMathSchema.type(ctx).create({ latex }),
    );
  },
));

/** Slash-command alias for the native CommonMark `> ` input rule. Keeping it
 * as an input rule means the result is still a real blockquote node and uses
 * the same undo/serialization path as pasted or loaded Markdown. */
export const slashBlockquoteInputRule = $inputRule((ctx) => wrappingInputRule(
  /^\s*\/(?:quote|引用)\s$/i,
  blockquoteSchema.type(ctx),
));

const listFoldKey = new PluginKey<DecorationSet>("floatnote-list-fold");

/** Split the visible parent text without transferring its existing subtree. */
export function handleListParentEnter(view: EditorView, event: KeyboardEvent): boolean {
  if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey
    || event.isComposing || view.composing || !view.editable) return false;
  const { state } = view;
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const { $from } = selection;
  if ($from.depth < 2 || $from.parent.type.name !== "paragraph") return false;
  const item = $from.node(-1);
  if (item.type.name !== "list_item" || $from.index(-1) !== 0) return false;
  let nestedOffset = -1;
  let nestedList: typeof item | undefined;
  item.forEach((child, offset) => {
    if (!nestedList && (child.type.name === "bullet_list" || child.type.name === "ordered_list")) {
      nestedList = child;
      nestedOffset = offset;
    }
  });
  if (!nestedList) return false;
  const itemPos = $from.before($from.depth - 1);
  const folded = listFoldKey.getState(state)?.find(itemPos, itemPos + 1)
    .some((decoration) => decoration.from === itemPos && decoration.spec.floatnoteFolded) ?? false;
  const paragraph = $from.parent.copy($from.parent.content.cut($from.parentOffset));
  const template = folded ? item : nestedList.firstChild!;
  const attrs = { ...template.attrs, ...(template.attrs.checked != null ? { checked: false } : {}) };
  const sibling = item.type.create(attrs, paragraph);
  const tr = state.tr.delete($from.pos, $from.end());
  const insertAt = tr.mapping.map(folded ? itemPos + item.nodeSize : itemPos + 1 + nestedOffset + 1);
  tr.insert(insertAt, sibling);
  tr.setSelection(TextSelection.create(tr.doc, insertAt + 2));
  view.dispatch(tr.scrollIntoView());
  return true;
}

export const quoteCardPlugin = $prose((ctx) => new Plugin({
  props: {
    decorations(state) {
      const decorations: Decoration[] = [];
      state.doc.descendants((node, pos) => {
        if (node.type.name !== "quote_card") return;
        const title = node.firstChild;
        if (!title) return;
        const lineEnd = title.textContent.indexOf("\n");
        const hiddenLength = lineEnd >= 0 ? lineEnd + 1 : title.content.size;
        if (hiddenLength > 0) decorations.push(Decoration.inline(
          pos + 2,
          pos + 2 + hiddenLength,
          { class: "fn-quote-card__title-line" },
        ));
      });
      return DecorationSet.create(state.doc, decorations);
    },
  },
  appendTransaction(transactions, _oldState, state) {
    if (!transactions.some((transaction) => transaction.docChanged)) return null;
    const quote = quoteCardSchema.type(ctx);
    const blockquote = state.schema.nodes.blockquote;
    let tr = state.tr;
    state.doc.descendants((node, pos) => {
      if (node.type === blockquote && /^\[!quote\](?:\s|$)/i.test(node.textContent)) {
        tr = tr.setNodeMarkup(pos, quote, { bundleId: null });
      } else if (node.type === quote && !/^\[!quote\](?:\s|$)/i.test(node.textContent)) {
        tr = tr.setNodeMarkup(pos, blockquote);
      }
    });
    return tr.steps.length ? tr : null;
  },
}));

export const tableToolsPlugin = $prose(() => new Plugin({
  view(view) {
    const toolbar = document.createElement("div");
    toolbar.className = "fn-table-tools";
    toolbar.contentEditable = "false";
    const actions: [string, (state: typeof view.state, dispatch?: typeof view.dispatch) => boolean][] = [
      ["+ 行", addRowAfter],
      ["− 行", deleteRow],
      ["+ 列", addColumnAfter],
      ["− 列", deleteColumn],
    ];
    for (const [label, command] of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.onmousedown = (event) => {
        event.preventDefault();
        command(view.state, view.dispatch);
        view.focus();
      };
      toolbar.append(button);
    }
    view.dom.parentElement?.append(toolbar);
    const update = () => {
      let inTable = false;
      for (let depth = view.state.selection.$from.depth; depth > 0; depth -= 1) {
        const name = view.state.selection.$from.node(depth).type.name;
        if (name === "table_cell" || name === "table_header") { inTable = true; break; }
      }
      toolbar.hidden = !inTable || !view.editable;
    };
    update();
    return { update, destroy: () => toolbar.remove() };
  },
}));

export const listFoldPlugin = $prose(() => new Plugin({
  key: listFoldKey,
  state: {
    init: () => DecorationSet.empty,
    apply(transaction, value) {
      let next = value.map(transaction.mapping, transaction.doc);
      const update = transaction.getMeta(listFoldKey) as { pos: number; folded: boolean } | undefined;
      if (!update) return next;
      if (update.folded) {
        const node = transaction.doc.nodeAt(update.pos);
        if (node?.type.name === "list_item") {
          next = next.add(transaction.doc, [Decoration.node(
            update.pos,
            update.pos + node.nodeSize,
            { class: "fn-list-item--folded" },
            { floatnoteFolded: true },
          )]);
        }
      } else {
        // find includes touching boundaries, including the previous sibling's end.
        next = next.remove(next.find(update.pos, update.pos + 1, (spec) => Boolean(spec.floatnoteFolded))
          .filter((decoration) => decoration.from === update.pos));
      }
      return next;
    },
  },
  props: {
    decorations: (state) => listFoldKey.getState(state),
  },
}));

export const listItemFoldView = $view(listItemSchema.node, (): NodeViewConstructor => {
  return (initialNode, view, getPos, initialDecorations) => {
  let node = initialNode;
  const dom = document.createElement("li");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "fn-list-fold-toggle";
  toggle.contentEditable = "false";
  toggle.setAttribute("aria-label", "收起或展开子列表");
  toggle.innerHTML = '<svg class="fn-list-fold-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="m4.25 2.5 3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const task = document.createElement("input");
  task.type = "checkbox";
  task.className = "fn-task-list-checkbox";
  task.contentEditable = "false";
  const contentDOM = document.createElement("div");
  contentDOM.className = "fn-list-item-content";
  dom.append(toggle, task, contentDOM);

  const hasNestedList = () => {
    let found = false;
    node.forEach((child) => { if (child.type.name === "bullet_list" || child.type.name === "ordered_list") found = true; });
    return found;
  };
  const updateState = (decorations: readonly Decoration[]) => {
    const folded = decorations.some((decoration) => Boolean(decoration.spec.floatnoteFolded));
    dom.classList.toggle("fn-list-item--folded", folded);
    const isTask = node.attrs.checked != null;
    dom.classList.toggle("fn-task-list-item", isTask);
    task.hidden = !isTask;
    task.checked = node.attrs.checked === true;
    toggle.hidden = !hasNestedList();
    toggle.setAttribute("aria-expanded", String(!folded));
    toggle.title = folded ? "展开子列表" : "折叠子列表";
  };
  updateState(initialDecorations);
  toggle.onmousedown = (event) => {
    event.preventDefault();
  };
  toggle.onclick = (event) => {
    event.preventDefault();
    const pos = getPos();
    if (pos === undefined) return;
    view.dispatch(view.state.tr.setMeta(listFoldKey, {
      pos,
      folded: !dom.classList.contains("fn-list-item--folded"),
    }));
  };
  task.onchange = () => {
    if (!view.editable) return;
    const pos = getPos();
    if (pos === undefined) return;
    view.dispatch(view.state.tr.setNodeAttribute(pos, "checked", task.checked));
  };
  return {
    dom,
    contentDOM,
    update(updated, decorations) {
      if (updated.type !== node.type) return false;
      node = updated;
      updateState(decorations);
      return true;
    },
    stopEvent: (event) => event.target === toggle || event.target === task,
    };
  };
});

export const codeBlockView = $view(codeBlockSchema.node, (): NodeViewConstructor => {
  return (initialNode, outerView, getPos) => {
    let node = initialNode;
    let updating = false;
    const dom = document.createElement("div");
    dom.className = "fn-structured-codeblock";
    const handle = createBlockHandle("选择整个代码块");
    const language = document.createElement("input");
    language.className = "fn-structured-codeblock__language";
    language.dataset.focusStyle = "quiet";
    language.value = String(node.attrs.language ?? "");
    language.placeholder = "language";
    const codeHost = document.createElement("div");
    dom.append(handle, language, codeHost);
    handle.addEventListener("mousedown", (event) => selectNodeFromPointer(event, outerView, getPos));
    const languageSlot = new Compartment();
    let languageGeneration = 0;
    const code = new CodeView({
      parent: codeHost,
      state: CodeState.create({
        doc: node.textContent,
        extensions: [
          codeHistory(),
          syntaxHighlighting(floatnoteCodeHighlight),
          languageSlot.of([]),
          codeKeymap.of([...defaultKeymap, ...historyKeymap]),
          CodeView.lineWrapping,
          CodeView.theme({
            "&": { background: "transparent" },
            ".cm-content": { padding: "0", fontFamily: "ui-monospace, 'SF Mono', monospace" },
            ".cm-line": { padding: "0" },
            ".cm-scroller": { overflow: "visible" },
            "&.cm-focused": { outline: "none" },
          }),
          CodeView.updateListener.of((update) => {
            if (!update.docChanged || updating || !outerView.editable) return;
            const pos = getPos();
            if (pos === undefined) return;
            const text = update.state.doc.toString();
            const replacement = node.type.create(node.attrs, text ? outerView.state.schema.text(text) : undefined);
            outerView.dispatch(outerView.state.tr.replaceWith(pos, pos + node.nodeSize, replacement));
          }),
        ],
      }),
    });
    const loadLanguage = (name: string) => {
      const generation = ++languageGeneration;
      const description = LanguageDescription.matchLanguageName(floatnoteCodeLanguages, name, true);
      if (!description) return void code.dispatch({ effects: languageSlot.reconfigure([]) });
      void description.load().then((support) => {
        if (generation === languageGeneration) code.dispatch({ effects: languageSlot.reconfigure(support) });
      });
    };
    loadLanguage(language.value);
    const commitLanguage = () => {
      if (!outerView.editable) return;
      const pos = getPos();
      if (pos === undefined || language.value === node.attrs.language) return;
      outerView.dispatch(outerView.state.tr.setNodeAttribute(pos, "language", language.value));
      loadLanguage(language.value);
    };
    language.addEventListener("change", commitLanguage);
    language.addEventListener("blur", commitLanguage);
    return {
      dom,
      update(updated) {
        if (updated.type !== node.type) return false;
        node = updated;
        language.value = String(node.attrs.language ?? "");
        if (code.state.doc.toString() !== node.textContent) {
          updating = true;
          code.dispatch({ changes: { from: 0, to: code.state.doc.length, insert: node.textContent } });
          updating = false;
        }
        return true;
      },
      selectNode: () => dom.classList.add("is-block-selected"),
      deselectNode: () => dom.classList.remove("is-block-selected"),
      stopEvent: () => true,
      ignoreMutation: () => true,
      destroy: () => code.destroy(),
    };
  };
});

export const imageView = $view(imageSchema.node, (ctx): NodeViewConstructor => {
  const runtime = ctx.get(floatnoteEditorRuntime.key);
  return (initialNode, outerView, getPos) => {
    let node = initialNode;
    let selected = false;
    const dom = document.createElement("span");
    dom.className = "fn-structured-image";
    dom.contentEditable = "false";
    const image = document.createElement("img");
    image.className = "fn-structured-image__image";
    image.draggable = true;
    const error = document.createElement("span");
    error.className = "fn-structured-image__error";
    error.textContent = "图片无法加载";
    const caption = document.createElement("input");
    caption.className = "fn-structured-image__caption";
    caption.placeholder = "添加图注…";
    caption.setAttribute("aria-label", "图片说明");
    const captionText = document.createElement("span");
    captionText.className = "fn-structured-image__caption-text";
    const tools = document.createElement("span");
    tools.className = "fn-structured-image__tools";
    const alignButtons = new Map<string, HTMLButtonElement>();
    for (const [value, label] of [["left", "图片左对齐"], ["center", "图片居中"], ["right", "图片右对齐"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "fn-structured-image__align-button";
      button.dataset.align = value;
      button.setAttribute("aria-label", label);
      button.title = label;
      const starts = value === "left" ? [1, 1, 1] : value === "right" ? [5, 3, 1] : [3, 1, 3];
      button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${starts.map((start, index) => `<path d="M${start} ${4 + index * 4}h${14 - start * 2}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`).join("")}</svg>`;
      button.onmousedown = (event) => event.preventDefault();
      button.onclick = () => {
        if (!outerView.editable) return;
        const pos = getPos();
        if (pos === undefined) return;
        outerView.dispatch(outerView.state.tr.setNodeAttribute(pos, "align", value === "left" ? null : value));
      };
      alignButtons.set(value, button);
      tools.append(button);
    }
    dom.append(image, error, captionText, caption, tools);
    for (const direction of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
      const handle = document.createElement("span");
      handle.className = `fn-structured-image__resize fn-structured-image__resize--${direction}`;
      handle.dataset.direction = direction;
      handle.onmousedown = (event) => {
        if (!outerView.editable) return;
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        const startY = event.clientY;
        const startWidth = image.getBoundingClientRect().width || image.naturalWidth || Number(node.attrs.width) || 320;
        const ratio = image.naturalWidth && image.naturalHeight ? image.naturalWidth / image.naturalHeight : 1;
        const move = (moveEvent: MouseEvent) => {
          const horizontal = direction.includes("w") ? startX - moveEvent.clientX : moveEvent.clientX - startX;
          const vertical = direction.includes("n") ? (startY - moveEvent.clientY) * ratio : (moveEvent.clientY - startY) * ratio;
          const delta = direction === "n" || direction === "s" ? vertical : horizontal;
          dom.style.width = `${Math.max(40, Math.round(startWidth + delta))}px`;
        };
        const finish = () => {
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", finish);
          const pos = getPos();
          if (pos === undefined) return;
          const resized = Math.max(40, Math.round(dom.getBoundingClientRect().width || Number.parseInt(dom.style.width, 10)));
          outerView.dispatch(outerView.state.tr.setNodeAttribute(pos, "width", resized));
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", finish, { once: true });
      };
      dom.append(handle);
    }

    const syncSelection = () => {
      dom.classList.toggle("is-selected", selected);
      caption.hidden = !selected;
      captionText.hidden = selected || !captionText.textContent;
    };
    const render = () => {
      const source = String(node.attrs.src ?? "");
      const safeSource = safeMarkdownUrl(source);
      const resolved = safeSource ? runtime.resolveImageSrc(safeSource) : "";
      dom.dataset.loadState = resolved ? "loading" : "error";
      if (image.src !== resolved) image.src = resolved;
      image.alt = String(node.attrs.alt ?? "");
      image.title = String(node.attrs.title ?? "");
      caption.value = String(node.attrs.alt ?? "");
      captionText.textContent = caption.value;
      dom.style.width = node.attrs.width == null ? "" : `${node.attrs.width}px`;
      dom.dataset.align = String(node.attrs.align ?? "");
      const resolvedAlign = String(node.attrs.align ?? "left");
      for (const [value, button] of alignButtons) {
        button.setAttribute("aria-pressed", String(value === resolvedAlign));
      }
      syncSelection();
    };
    image.addEventListener("load", () => { dom.dataset.loadState = "ready"; });
    image.addEventListener("error", () => { dom.dataset.loadState = "error"; });
    image.addEventListener("mousedown", (event) => {
      if (!outerView.editable) return;
      event.preventDefault();
      const pos = getPos();
      if (pos === undefined) return;
      outerView.dispatch(outerView.state.tr.setSelection(NodeSelection.create(outerView.state.doc, pos)));
      outerView.focus();
    });
    const commitCaption = () => {
      if (!outerView.editable || caption.value === node.attrs.alt) return;
      const pos = getPos();
      if (pos === undefined) return;
      outerView.dispatch(outerView.state.tr.setNodeAttribute(pos, "alt", caption.value));
    };
    caption.addEventListener("change", commitCaption);
    caption.addEventListener("blur", commitCaption);
    render();
    return {
      dom,
      update(updated) {
        if (updated.type !== node.type) return false;
        node = updated;
        render();
        return true;
      },
      selectNode() {
        selected = true;
        syncSelection();
      },
      deselectNode() {
        selected = false;
        syncSelection();
      },
      stopEvent: (event) => dom.contains(event.target as Node),
      ignoreMutation: () => true,
    };
  };
});

/** Shared URL policy for editor node views and the read-only renderer. */
export function safeMarkdownUrl(value: string): string {
  return isSafeUrl(value) ? value : "";
}

export const floatnoteMarkdownPlugins = [
  floatnoteEditorRuntime,
  floatnoteRemarkMath,
  floatnoteRemarkQuoteCards,
  floatnoteRemarkImageAttributes,
  inlineMathSchema,
  blockMathSchema,
  annotationMarkSchema,
  assistantRefSchema,
  floatnoteImageSchema,
  floatnoteLinkSchema,
  quoteCardSchema,
  inlineMathView,
  blockMathView,
  blockquoteView,
  dividerView,
  quoteCardView,
  inlineMathInputRule,
  slashBlockquoteInputRule,
  listFoldPlugin,
  quoteCardPlugin,
  tableToolsPlugin,
  listItemFoldView,
  codeBlockView,
  imageView,
].flat(4) as MilkdownPlugin[];
