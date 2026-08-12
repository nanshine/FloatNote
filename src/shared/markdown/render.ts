import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { isSafeUrl } from "./inline";
import { mathPlugin } from "./math";
import { wireOpenUrlLink } from "../../platform/open-url";

function stripUnsafeDestinations(markdown: string): string {
  return markdown.replace(
    /(!?)\[([^\]]*)\]\(\s*((?:javascript|data|vbscript):(?:[^()]|\([^()]*\))*)\)/gi,
    (_match, image: string, label: string) => image ? label : label,
  );
}

function taskListPlugin(md: MarkdownIt): void {
  md.core.ruler.after("inline", "floatnote_task_lists", (state) => {
    for (let index = 2; index < state.tokens.length; index += 1) {
      const token = state.tokens[index];
      if (token.type !== "inline" || state.tokens[index - 1]?.type !== "paragraph_open") continue;
      const item = state.tokens[index - 2];
      if (item?.type !== "list_item_open") continue;
      const first = token.children?.[0];
      if (!first || first.type !== "text") continue;
      const match = /^\[([ xX])\]\s+/.exec(first.content);
      if (!match) continue;
      first.content = first.content.slice(match[0].length);
      item.attrJoin("class", "fn-markdown-task-item");
      token.children!.unshift(new state.Token("floatnote_checkbox", "input", 0));
      token.children![0].meta = { checked: match[1].toLowerCase() === "x" };
    }
  });
  md.renderer.rules.floatnote_checkbox = (tokens: Token[], index: number) => (
    `<input class="fn-markdown-task" type="checkbox" disabled${tokens[index].meta?.checked ? " checked" : ""}> `
  );
}

const markdown = new MarkdownIt({
  html: false,
  breaks: false,
  linkify: false,
  typographer: false,
});

markdown.validateLink = isSafeUrl;
markdown.use(taskListPlugin);
markdown.use(mathPlugin);
markdown.renderer.rules.softbreak = () => " ";
markdown.renderer.rules.table_open = () => '<div class="fn-markdown-table-scroll"><table>';
markdown.renderer.rules.table_close = () => "</table></div>";
markdown.renderer.rules.image = (tokens, index, _options, _env, self) => {
  const token = tokens[index];
  return `<span class="fn-markdown-image-alt">${mdEscape(self.renderInlineAsText(token.children ?? [], _options, _env))}</span>`;
};
markdown.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index];
  const language = token.info.trim().split(/\s+/u)[0] ?? "";
  const languageClass = language ? ` class="language-${mdEscape(language)}"` : "";
  return `<pre class="chat-codeblock"><code${languageClass}>${mdEscape(token.content.replace(/\n$/u, ""))}</code></pre>`;
};

function mdEscape(value: string): string {
  return markdown.utils.escapeHtml(value);
}

export function renderMarkdown(source: string): string {
  if (!source) return "";
  return markdown.render(stripUnsafeDestinations(source)).replace(/>\n</g, "><").trim();
}

export function fillMarkdown(element: HTMLElement, source: string): void {
  element.classList.add("fn-markdown");
  try {
    element.innerHTML = renderMarkdown(source);
    for (const anchor of element.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      wireOpenUrlLink(anchor, anchor.getAttribute("href") ?? "");
    }
  } catch {
    element.replaceChildren(document.createTextNode(source));
  }
}
