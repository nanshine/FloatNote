import { HighlightStyle, LanguageDescription } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export const floatnoteCodeHighlight = HighlightStyle.define([
  { tag: tags.comment, color: "var(--color-syntax-comment)", fontStyle: "italic" },
  { tag: tags.keyword, color: "var(--color-syntax-keyword)" },
  { tag: [tags.atom, tags.bool, tags.number], color: "var(--color-syntax-literal)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--color-syntax-string)" },
  { tag: [tags.variableName, tags.definition(tags.variableName)], color: "var(--color-syntax-variable)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.definition(tags.variableName))], color: "var(--color-syntax-function)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--color-syntax-property)" },
  { tag: [tags.typeName, tags.tagName], color: "var(--color-syntax-type)" },
  { tag: [tags.operator, tags.punctuation, tags.meta], color: "var(--color-syntax-punctuation)" },
]);

export const floatnoteCodeLanguages: LanguageDescription[] = [
  LanguageDescription.of({ name: "JavaScript", alias: ["js", "javascript", "jsx"], extensions: ["js", "mjs", "cjs"], load: () => import("@codemirror/lang-javascript").then((module) => module.javascript()) }),
  LanguageDescription.of({ name: "TypeScript", alias: ["ts", "typescript", "tsx"], extensions: ["ts"], load: () => import("@codemirror/lang-javascript").then((module) => module.javascript({ typescript: true })) }),
  LanguageDescription.of({ name: "JSON", alias: ["json", "jsonc"], extensions: ["json", "jsonc"], load: () => import("@codemirror/lang-json").then((module) => module.json()) }),
  LanguageDescription.of({ name: "HTML", alias: ["html"], extensions: ["html", "htm"], load: () => import("@codemirror/lang-html").then((module) => module.html()) }),
  LanguageDescription.of({ name: "CSS", alias: ["css"], extensions: ["css"], load: () => import("@codemirror/lang-css").then((module) => module.css()) }),
  LanguageDescription.of({ name: "Python", alias: ["py", "python"], extensions: ["py"], load: () => import("@codemirror/lang-python").then((module) => module.python()) }),
  LanguageDescription.of({ name: "Rust", alias: ["rs", "rust"], extensions: ["rs"], load: () => import("@codemirror/lang-rust").then((module) => module.rust()) }),
  LanguageDescription.of({ name: "SQL", alias: ["sql"], extensions: ["sql"], load: () => import("@codemirror/lang-sql").then((module) => module.sql()) }),
];
