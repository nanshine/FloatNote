import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const editorCss = readFileSync(resolve(root, "src/shared/markdown/structured-editor.css"), "utf8");
const codeLanguages = readFileSync(resolve(root, "src/shared/markdown/code-languages.ts"), "utf8");

describe("dark-theme Markdown readability", () => {
  it("keeps list content at the inherited prose color", () => {
    expect(editorCss).toMatch(/\.fn-structured-editor\s*\{/);
    expect(editorCss).not.toMatch(/\.fn-structured-editor li\s*\{[^}]*color:/s);
  });

  it("uses adaptive semantic colors for readable preview elements", () => {
    expect(editorCss).toMatch(/\.fn-structured-editor blockquote\s*\{[^}]*color:\s*var\(--color-text-muted\)/s);
    expect(editorCss).toMatch(/\.fn-structured-codeblock\s*\{[^}]*background:\s*var\(--color-surface-3\)/s);
    expect(editorCss).not.toMatch(/color:\s*#(?:374151|6b7280|9ca3af)/i);
  });

  it("uses adaptive semantic colors for note syntax highlighting", () => {
    for (const token of [
      "--color-syntax-comment",
      "--color-syntax-keyword",
      "--color-syntax-literal",
      "--color-syntax-string",
      "--color-syntax-variable",
      "--color-syntax-function",
      "--color-syntax-property",
      "--color-syntax-type",
      "--color-syntax-punctuation",
    ]) {
      expect(codeLanguages).toContain(`var(${token})`);
    }
  });
});
