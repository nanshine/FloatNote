import { markdownLanguage } from "@codemirror/lang-markdown";
import { Autolink, MarkdownParser, Strikethrough } from "@lezer/markdown";
import type { SyntaxNode } from "@lezer/common";
import { escapeHtml } from "../escape";
import { isSafeUrl } from "./safe-url";
export { isSafeUrl } from "./safe-url";

const inlineParser = (markdownLanguage.parser as MarkdownParser).configure([Strikethrough, Autolink]);

function safeHref(url: string): string {
  return isSafeUrl(url) ? url.trim() : "";
}

function renderChildren(node: SyntaxNode, text: string): string {
  let out = "";
  let pos = node.from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.from > pos) out += escapeHtml(text.slice(pos, child.from));
    out += renderNode(child, text);
    pos = Math.max(pos, child.to);
  }
  if (node.to > pos) out += escapeHtml(text.slice(pos, node.to));
  return out;
}

function renderNode(node: SyntaxNode, text: string): string {
  switch (node.name) {
    case "EmphasisMark": case "StrikethroughMark": case "CodeMark": case "LinkMark": return "";
    case "Document": case "Paragraph": return renderChildren(node, text);
    case "StrongEmphasis": return `<strong>${renderChildren(node, text)}</strong>`;
    case "Emphasis": return `<em>${renderChildren(node, text)}</em>`;
    case "Strikethrough": return `<del>${renderChildren(node, text)}</del>`;
    case "InlineCode": return `<code>${escapeHtml(text.slice(node.from, node.to).replace(/^`+|`+$/g, ""))}</code>`;
    case "Link": {
      const match = /^\[([\s\S]*)\]\(([\s\S]*)\)$/.exec(text.slice(node.from, node.to));
      return match ? `<a href="${escapeHtml(safeHref(match[2]))}">${renderInline(match[1])}</a>` : escapeHtml(text.slice(node.from, node.to));
    }
    case "URL": {
      const url = text.slice(node.from, node.to);
      return `<a href="${escapeHtml(safeHref(url))}">${escapeHtml(url)}</a>`;
    }
    case "Autolink": {
      const url = text.slice(node.from + 1, node.to - 1);
      return `<a href="${escapeHtml(safeHref(url))}">${escapeHtml(url)}</a>`;
    }
    case "Escape": return escapeHtml(text.slice(node.from, node.to).replace(/^\\/, ""));
    default: return node.firstChild ? renderChildren(node, text) : escapeHtml(text.slice(node.from, node.to));
  }
}

export function renderInline(text: string): string {
  return renderNode(inlineParser.parse(text).topNode, text);
}
