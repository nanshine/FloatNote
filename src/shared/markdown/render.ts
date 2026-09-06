import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeKatex from "rehype-katex";
import rehypeStringify from "rehype-stringify";
import type { Root as MdastRoot, RootContent as MdastContent } from "mdast";
import type { Element, Root as HastRoot, RootContent as HastContent } from "hast";
import { findMathRanges } from "./math";
import { wireOpenUrlLink } from "../../platform/open-url";

type MdastParent = MdastRoot | Extract<MdastContent, { children: unknown }>;

function stripUnsafeDestinations(markdown: string): string {
  return markdown.replace(
    /(!?)\[([^\]]*)\]\(\s*((?:javascript|data|vbscript):(?:[^()]|\([^()]*\))*)\)/gi,
    (_match, _image: string, label: string) => label,
  );
}

function codeRanges(source: string): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  for (const match of source.matchAll(/(^|\n)( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2\3(?=\n|$)/g)) {
    ranges.push({ from: match.index, to: match.index + match[0].length });
  }
  for (const match of source.matchAll(/(`+)(?!`)([^\n]*?)\1/g)) {
    ranges.push({ from: match.index, to: match.index + match[0].length });
  }
  return ranges;
}

/** remark-math accepts deliberately broad dollar syntax. Escape every dollar
 * not accepted by FloatNote's stricter streaming/currency policy first. */
function normalizeMathDelimiters(source: string): string {
  const accepted = findMathRanges(source);
  const code = codeRanges(source);
  const protectedAt = (position: number) => [...accepted, ...code]
    .some((range) => position >= range.from && position < range.to);
  let output = "";
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "$" && !protectedAt(index) && source[index - 1] !== "\\") output += "\\";
    output += source[index];
  }
  return output;
}

function remarkFloatNoteSafety() {
  return (tree: MdastRoot) => {
    const walk = (parent: MdastParent) => {
      const children = parent.children as MdastContent[];
      for (let index = 0; index < children.length; index += 1) {
        const node = children[index];
        if (node.type === "image") {
          children[index] = { type: "text", value: node.alt ?? "" };
          continue;
        }
        if (node.type === "html") {
          children[index] = { type: "text", value: node.value };
          continue;
        }
        if (node.type === "text") node.value = node.value.replace(/\n/g, " ");
        if ("children" in node && Array.isArray(node.children)) walk(node as MdastParent);
      }
    };
    walk(tree);
  };
}

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "input"],
  attributes: {
    ...defaultSchema.attributes,
    input: ["type", "checked", "disabled", "className"],
    li: [...(defaultSchema.attributes?.li ?? []), "className"],
  },
};

function visitHast(node: HastRoot | HastContent, visitor: (element: Element, parent?: Element | HastRoot) => void, parent?: Element | HastRoot): void {
  if (node.type === "element") visitor(node, parent);
  if ("children" in node) {
    for (const child of node.children) visitHast(child, visitor, node as Element | HastRoot);
  }
}

function rehypeFloatNotePresentation() {
  return (tree: HastRoot) => {
    const tables: { table: Element; parent: Element | HastRoot }[] = [];
    visitHast(tree, (element, parent) => {
      if (element.tagName === "table" && parent) tables.push({ table: element, parent });
      if (element.tagName === "pre") {
        element.properties.className = ["chat-codeblock"];
        const code = element.children[0];
        if (code?.type === "element" && code.tagName === "code") {
          const text = code.children[0];
          if (text?.type === "text") text.value = text.value.replace(/\n$/, "");
        }
      }
      if (element.tagName === "input") {
        element.properties.disabled = true;
        element.properties.className = ["fn-markdown-task"];
      }
      const classes = element.properties.className;
      if (Array.isArray(classes) && classes.includes("katex-error")) {
        element.properties.className = ["fn-math-error"];
      }
    });
    for (const { table, parent } of tables) {
      const index = parent.children.indexOf(table);
      if (index >= 0) parent.children.splice(index, 1, {
        type: "element",
        tagName: "div",
        properties: { className: ["fn-markdown-table-scroll"] },
        children: [table],
      });
    }
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkFloatNoteSafety)
  .use(remarkRehype)
  .use(rehypeSanitize, sanitizeSchema)
  .use(rehypeKatex, {
    trust: false,
    strict: "ignore",
    maxExpand: 1_000,
    maxSize: 20,
    output: "htmlAndMathml",
  })
  .use(rehypeFloatNotePresentation)
  .use(rehypeStringify);

export function renderMarkdown(source: string): string {
  if (!source) return "";
  return String(processor.processSync(normalizeMathDelimiters(stripUnsafeDestinations(source))))
    .replace(/&#x26;/g, "&amp;")
    .replace(/&#x3C;/g, "&lt;")
    .replace(/&#x3E;/g, "&gt;")
    .replace(/(&lt;\/?[^<>]*?)>/g, "$1&gt;")
    .replace(/(<code(?:\s[^>]*)?>)([\s\S]*?)(<\/code>)/g, (_match, open: string, body: string, close: string) => (
      `${open}${body.replace(/"/g, "&quot;")}${close}`
    ))
    .replace(/>\n</g, "><")
    .trim();
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
