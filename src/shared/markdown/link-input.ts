import { parserCtx } from "@milkdown/kit/core";
import { InputRule, undoInputRule } from "@milkdown/kit/prose/inputrules";
import { Fragment, Slice, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@milkdown/kit/prose/state";
import { $inputRule, $prose } from "@milkdown/kit/utils";
import type { EditorView } from "@milkdown/kit/prose/view";
import { isSafeUrl } from "./safe-url";

/** Only destinations the native opener can actually open. */
export function externalLinkUrl(value: string): string | null {
  const text = value.trim();
  if (!text || /[\s<>"\\\u0000-\u001f\u007f]/.test(text)) return null;
  const url = /^www\./i.test(text) ? `https://${text}`
    : /^[^@:/]+@[^@:/]+\.[^@:/]+$/.test(text) ? `mailto:${text}` : text;
  try {
    const parsed = new URL(url);
    if ((parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname) return url;
    if (parsed.protocol === "mailto:" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(parsed.pathname)) return url;
  } catch { /* Invalid or incomplete input remains ordinary text. */ }
  return null;
}

function inCode(state: EditorState): boolean {
  return Boolean(state.selection.$from.parent.type.spec.code
    || (state.storedMarks ?? state.selection.$from.marks()).some((mark) => mark.type.spec.code));
}

const literalLinks = new PluginKey<{ from: number; to: number }[]>("floatnoteLiteralLinks");
const linkInputMeta = "floatnoteLinkInput";

export function undoLinkInput(view: EditorView, event: KeyboardEvent): boolean {
  const modifier = /Mac/i.test(navigator.platform) ? event.metaKey : event.ctrlKey;
  if (!view.editable || !modifier || event.shiftKey || event.altKey || event.isComposing || event.key.toLowerCase() !== "z") return false;
  const pending = view.state.plugins.some((plugin) => plugin.spec.isInputRules
    && plugin.getState(view.state)?.transform?.getMeta(linkInputMeta));
  return pending ? undoInputRule(view.state, view.dispatch) : false;
}

function hasProtectedContent(state: EditorState, from: number, to: number): boolean {
  let protectedContent = (literalLinks.getState(state) ?? []).some((range) => range.from < to && range.to > from);
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isInline && (!node.isText || node.marks.some((mark) => mark.type.spec.code || mark.type.name === "link"))) {
      protectedContent = true;
    }
  });
  return protectedContent;
}

function linkedParagraph(doc: ProseNode): ProseNode | null {
  const paragraph = doc.firstChild;
  if (doc.childCount !== 1 || paragraph?.type.name !== "paragraph" || !paragraph.childCount) return null;
  let valid = true;
  paragraph.forEach((node) => {
    const link = node.marks.find((mark) => mark.type.name === "link");
    if (!node.isText || !link || !isSafeUrl(String(link.attrs.href))) valid = false;
  });
  return valid ? paragraph : null;
}

// The parser, rather than a URL regex, handles escaped labels, titles and
// balanced parentheses in Markdown destinations.
export const markdownLinkInputRule = $inputRule((ctx) => new InputRule(
  /\[[^\n]*\]\([^\n]*\)$/,
  (state, match, start, end) => {
    for (let offset = 0; offset < match[0].length; offset += 1) {
      if (match[0][offset] !== "[") continue;
      const from = start + offset;
      const preceding = state.doc.textBetween(state.selection.$from.start(), from, "", "\ufffc");
      if (preceding.endsWith("!") || (preceding.match(/\\+$/)?.[0].length ?? 0) % 2) continue;
      if (hasProtectedContent(state, from, end)) continue;
      const paragraph = linkedParagraph(ctx.get(parserCtx)(match[0].slice(offset)));
      if (!paragraph) continue;
      const inherited = (state.storedMarks ?? state.selection.$from.marks()).filter((mark) => mark.type.name !== "link");
      const children: ProseNode[] = [];
      paragraph.forEach((node) => {
        let marks = node.marks;
        for (const mark of inherited) marks = mark.addToSet(marks);
        children.push(node.mark(marks));
      });
      return state.tr.replaceWith(from, end, Fragment.from(children)).removeStoredMark(state.schema.marks.link)
        .setMeta(linkInputMeta, true);
    }
    return null;
  },
  { inCodeMark: false },
));

function bareLink(text: string): { label: string; href: string } | null {
  let label = text.replace(/[.,!?;:，。！？；：、…]+$/u, "");
  for (;;) {
    const closing = label.at(-1);
    const opening = closing === ")" ? "(" : closing === "]" ? "[" : closing === "}" ? "{" : null;
    if (!opening || label.split(closing!).length <= label.split(opening).length) break;
    label = label.slice(0, -1);
  }
  const href = externalLinkUrl(label);
  return href ? { label, href } : null;
}

export const bareLinkInputRule = $inputRule(() => new InputRule(
  /(?:^|[\s（(])([^\s]+)([ \u3000])$/,
  (state, match, start, end) => {
    const link = bareLink(match[1]);
    if (!link) return null;
    const from = start + match[0].length - match[1].length - match[2].length;
    if (hasProtectedContent(state, from, end)) return null;
    return state.tr.insertText(match[1] + match[2], from, end)
      .addMark(from, from + link.label.length, state.schema.marks.link.create({ href: link.href }))
      .removeStoredMark(state.schema.marks.link).setMeta(linkInputMeta, true);
  },
  { inCodeMark: false },
));

export const linkPastePlugin = $prose((ctx) => {
  let plainPaste = false;
  return new Plugin({
    key: literalLinks,
    state: {
      init: () => [],
      apply(tr, ranges: { from: number; to: number }[]) {
        const mapped = ranges.map((range) => ({ from: tr.mapping.map(range.from, 1), to: tr.mapping.map(range.to, -1) }))
          .filter((range) => range.from < range.to);
        const literal = tr.getMeta(literalLinks) as { from: number; to: number } | undefined;
        if (literal) mapped.push(literal);
        return mapped;
      },
    },
    props: {
      transformPastedText(text, plain) {
        plainPaste = plain;
        return text;
      },
      transformPastedHTML(html) {
        plainPaste = false;
        return html;
      },
      clipboardTextParser(text, context, plain, view) {
        const literal = () => Slice.maxOpen(Fragment.from(text.split(/(?:\r\n?|\n)+/).map((line) => (
          view.state.schema.nodes.paragraph.create(null, line ? view.state.schema.text(line, context.marks()) : null)
        ))));
        if (plain || inCode(view.state)) return literal();
        const href = externalLinkUrl(text);
        if (href) {
          return new Slice(Fragment.from(view.state.schema.text(text.trim(), [view.state.schema.marks.link.create({ href })])), 0, 0);
        }
        // Parse a complete inline Markdown link, leaving unrelated plain-text
        // paste semantics (including multiline text) unchanged.
        const paragraph = linkedParagraph(ctx.get(parserCtx)(text.trim()));
        return paragraph ? new Slice(paragraph.content, 0, 0) : literal();
      },
      handlePaste(view, event, slice) {
        const plain = plainPaste;
        plainPaste = false;
        const { state } = view;
        const { selection } = state;
        if (!view.editable || inCode(state)) return false;
        if (plain) {
          const tr = state.tr.replaceSelection(slice);
          tr.setMeta(literalLinks, { from: selection.from, to: tr.selection.to });
          view.dispatch(tr.setMeta("paste", true).setMeta("uiEvent", "paste").scrollIntoView());
          return true;
        }
        if (selection.empty
          || !(selection instanceof TextSelection) || !selection.$from.sameParent(selection.$to)) return false;
        const href = externalLinkUrl(event.clipboardData?.getData("text/plain") ?? "");
        if (!href || hasCodeOrAtom(state, selection.from, selection.to)) return false;
        view.dispatch(state.tr.addMark(selection.from, selection.to, state.schema.marks.link.create({ href }))
          .removeStoredMark(state.schema.marks.link).scrollIntoView());
        return true;
      },
      handleKeyDown(view, event) {
        if (event.key !== "Enter" || event.isComposing || !view.editable || !view.state.selection.empty || inCode(view.state)) return false;
        const { state } = view;
        const { $from } = state.selection;
        const text = $from.parent.textBetween(0, $from.parentOffset, "", "\ufffc");
        const token = /(?:^|[\s（(])([^\s]+)$/.exec(text)?.[1];
        const link = token && bareLink(token);
        if (link) {
          const from = $from.pos - token.length;
          if (!hasProtectedContent(state, from, $from.pos)) {
            view.dispatch(state.tr.addMark(from, from + link.label.length, state.schema.marks.link.create({ href: link.href }))
              .removeStoredMark(state.schema.marks.link));
          }
        }
        return false; // Let the normal Enter command perform its usual action.
      },
    },
  });
});

export function hasCodeOrAtom(state: EditorState, from: number, to: number): boolean {
  let found = inCode(state);
  state.doc.nodesBetween(from, to, (node) => {
    if (node.type.spec.code || (node.isInline && !node.isText) || node.marks.some((mark) => mark.type.spec.code)) found = true;
  });
  return found;
}
