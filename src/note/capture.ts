import { mapAnnotations, mapQuoteSources, type InboxMetadata } from "@floatnote/note-logic";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { StructuredMarkdownEditor } from "../shared/markdown/structured-editor";
import { htmlToMarkdown } from "../shared/markdown/from-html";
import { buildCaretInsert } from "./append";
import { buildQuoteAppendChange, buildQuoteBlock, quoteCardRanges, resolveMergeTarget, type Source } from "./quote";

export type QuotePayload = { text: string; html: string | null; source: Source | null };

export function applyQuoteSources(view: EditorView, markdown: string, metadata: InboxMetadata): void {
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

export function quoteSourcesFromNodes(view: EditorView, markdown: string): InboxMetadata["quoteSources"] {
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

/** Shared caret insertion and source merging for inboxes and standalone documents. */
export function captureQuote(editor: StructuredMarkdownEditor, payload: QuotePayload,
  metadata: InboxMetadata = { tags: [], annotations: [], quoteSources: editor.withView((view) => quoteSourcesFromNodes(view, editor.getMarkdown())) },
  afterReplace?: (markdown: string, metadata: InboxMetadata) => void,
): InboxMetadata {
  const body = (payload.html && htmlToMarkdown(payload.html)) || payload.text;
  const oldMarkdown = editor.getMarkdown();
  const liveCaret = editor.withView((view) => editor.markdownOffsetAt(view.state.selection.from));
  const caret = Math.max(0, Math.min(liveCaret ?? 0, oldMarkdown.length));
  const currentAnnotations = metadata.annotations;
  const target = resolveMergeTarget(oldMarkdown, caret, payload.source, metadata.quoteSources);
  let change: { from: number; to: number; insert: string };
  let newQuoteSource: InboxMetadata["quoteSources"][number] | null = null;
  if (target.kind === "merge") {
    change = buildQuoteAppendChange(
      oldMarkdown.slice(target.range.from, target.range.to),
      target.range.from,
      target.range.to,
      body,
    );
  } else {
    const block = buildQuoteBlock(body, payload.source);
    const insert = buildCaretInsert(oldMarkdown.slice(0, target.at), oldMarkdown.slice(target.at), block);
    change = { from: target.at, to: target.at, insert };
    if (payload.source?.bundleId) {
      newQuoteSource = {
        cardFrom: target.at + insert.indexOf(block),
        bundleId: payload.source.bundleId,
      };
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
    quoteSources: [
      ...mapQuoteSources(oldMarkdown, nextMarkdown, metadata.quoteSources, [change]),
      ...(newQuoteSource ? [newQuoteSource] : []),
    ],
  };
  editor.replace(nextMarkdown, { addToHistory: true });
  afterReplace?.(nextMarkdown, metadata);
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
  return metadata;
}
