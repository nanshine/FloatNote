import katex from "katex";
import "katex/dist/katex.min.css";
import { escapeHtml } from "../escape";

const renderOptions = {
  throwOnError: true,
  trust: false,
  strict: "ignore" as const,
  maxExpand: 1_000,
  maxSize: 20,
  output: "htmlAndMathml" as const,
};

export interface MathRange {
  from: number;
  to: number;
  expression: string;
  display: boolean;
}

interface TextRange {
  from: number;
  to: number;
}

function isEscaped(source: string, index: number): boolean {
  let slashes = 0;
  for (let pos = index - 1; pos >= 0 && source[pos] === "\\"; pos -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function overlaps(ranges: readonly TextRange[], from: number, to: number): boolean {
  return ranges.some((range) => range.from < to && range.to > from);
}

function lineRanges(source: string): TextRange[] {
  const lines: TextRange[] = [];
  let from = 0;
  while (from <= source.length) {
    const newline = source.indexOf("\n", from);
    const to = newline < 0 ? source.length : newline;
    lines.push({ from, to });
    if (newline < 0) break;
    from = newline + 1;
  }
  return lines;
}

export function findMathRanges(source: string, excluded: readonly TextRange[] = []): MathRange[] {
  const found: MathRange[] = [];
  const claimedBlocks: TextRange[] = [];
  const lines = lineRanges(source);

  for (let index = 0; index < lines.length; index += 1) {
    const open = lines[index];
    if (source.slice(open.from, open.to).trim() !== "$$" || overlaps(excluded, open.from, open.to)) continue;
    let closeIndex = index + 1;
    while (closeIndex < lines.length) {
      const candidate = lines[closeIndex];
      if (source.slice(candidate.from, candidate.to).trim() === "$$" &&
          !overlaps(excluded, candidate.from, candidate.to)) break;
      closeIndex += 1;
    }
    if (closeIndex >= lines.length) continue;
    const close = lines[closeIndex];
    const range = { from: open.from, to: close.to };
    if (overlaps(excluded, range.from, range.to)) continue;
    const expression = source.slice(Math.min(open.to + 1, source.length), close.from).trim();
    if (!expression) continue;
    found.push({ ...range, expression, display: true });
    claimedBlocks.push(range);
    index = closeIndex;
  }

  for (const line of lines) {
    if (overlaps(claimedBlocks, line.from, line.to)) continue;
    let pos = line.from;
    while (pos < line.to) {
      const start = source.indexOf("$", pos);
      if (start < 0 || start >= line.to) break;
      if (source[start + 1] === "$" || isEscaped(source, start) || /\s/u.test(source[start + 1] ?? "")) {
        pos = start + 1;
        continue;
      }
      let end = start + 1;
      while (end < line.to) {
        end = source.indexOf("$", end);
        if (end < 0 || end >= line.to) break;
        if (!isEscaped(source, end)) break;
        end += 1;
      }
      if (end < 0 || end >= line.to) break;
      const expression = source.slice(start + 1, end);
      const after = source[end + 1] ?? "";
      if (expression && !/\s$/u.test(expression) && !/\d/u.test(after) &&
          !overlaps(excluded, start, end + 1)) {
        found.push({ from: start, to: end + 1, expression, display: false });
        pos = end + 1;
      } else {
        pos = start + 1;
      }
    }
  }

  return found.sort((left, right) => left.from - right.from);
}

export function renderMath(expression: string, displayMode: boolean): string {
  try {
    return katex.renderToString(expression, { ...renderOptions, displayMode });
  } catch {
    const delimiter = displayMode ? "$$" : "$";
    return `<span class="fn-math-error" title="公式语法无效">${escapeHtml(`${delimiter}${expression}${delimiter}`)}</span>`;
  }
}
