import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const turndown = new TurndownService({
  bulletListMarker: "-",
  emDelimiter: "*",
  strongDelimiter: "**",
  codeBlockStyle: "fenced",
});
turndown.use(gfm);

/** Convert clipboard HTML to the canonical FloatNote Markdown dialect. */
export function htmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return "";
  return turndown
    .turndown(html)
    .replace(/^(\s*)([-*+]|\d+\.)\s{2,}/gm, "$1$2 ")
    .trim();
}
