import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const iconFiles = ["socrates.svg", "socrates_head_icon.svg"] as const;

describe("Socrates SVG assets", () => {
  it.each(iconFiles)("keeps %s colors independent of embedded CSS", (file) => {
    const svg = readFileSync(new URL(file, import.meta.url), "utf8");
    const shapes = [...svg.matchAll(/<(?:path|polygon|polyline)\b[^>]*>/g)].map(
      ([shape]) => shape,
    );

    expect(svg).not.toContain("<style");
    expect(svg).not.toMatch(/\bclass=/);
    expect(shapes.length).toBeGreaterThan(0);
    for (const shape of shapes) {
      expect(shape).toMatch(/\bfill="[^"]+"/);
      expect(shape).toMatch(/\bstroke="[^"]+"/);
    }
  });
});
