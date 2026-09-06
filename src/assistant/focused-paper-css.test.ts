import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = `${readFileSync(new URL("./styles.css", import.meta.url), "utf8")}\n${readFileSync(new URL("../shared/markdown/structured-editor.css", import.meta.url), "utf8")}`;

describe("focused paper CSS", () => {
  it("uses the specified continuously responsive paper geometry", () => {
    expect(css).toContain("width: min(920px, calc(100vw - 32px));");
    expect(css).toContain("height: min(720px, calc(100vh - 64px));");
  });

  it("removes nested editor chrome and reserves a safe action area", () => {
    expect(css).toMatch(/\.assistant-input-wrap\.fn-input-large \.fn-assistant-structured-editor\s*\{[^}]*border:\s*0;/s);
    expect(css).toMatch(/\.assistant-input-wrap\.fn-input-large \.fn-assistant-structured-editor > \.editor\s*\{[^}]*padding:[^;]*;/s);
  });

  it("keeps the compact composer pill visible before and after focus", () => {
    expect(css).toMatch(
      /\.fn-assistant-structured-editor\s*\{[^}]*border:\s*var\(--fn-border-width\) solid var\(--color-border\);[^}]*border-radius:\s*18px;[^}]*background:\s*var\(--color-surface\);/s,
    );
    expect(css).toMatch(
      /\.fn-assistant-structured-editor:focus-within\s*\{[^}]*border-color:\s*var\(--color-accent\);[^}]*box-shadow:\s*inset 0 0 0 1px var\(--color-accent\);/s,
    );
    expect(css).toMatch(
      /\.assistant-input-wrap\.fn-input-large \.fn-assistant-structured-editor\s*\{[^}]*box-shadow:\s*none;/s,
    );
  });

  it("insets line selection geometry from the paper edges", () => {
    expect(css).toMatch(/\.assistant-input-wrap\.fn-input-large \.fn-assistant-structured-editor > \.editor\s*\{[^}]*padding:[^;]*;/s);
  });

  it("keeps the close action above the focused text", () => {
    expect(css).toMatch(/\.assistant-input-wrap\.fn-input-large \.assistant-expand\s*\{[^}]*top:\s*clamp\(6px,\s*1\.5vh,\s*10px\);/s);
    expect(css).toMatch(/\.assistant-input-wrap\.fn-input-large \.fn-assistant-structured-editor > \.editor\s*\{[^}]*padding:\s*clamp\(56px,\s*8vh,\s*80px\)/s);
  });

  it("keeps candidate popovers above the focused layer", () => {
    const overlayZ = Number(css.match(/\.fn-input-overlay\s*\{[^}]*z-index:\s*(\d+)/s)?.[1]);
    const popoverZ = Number(css.match(/\.fn-ref-popover\s*\{[^}]*z-index:\s*(\d+)/s)?.[1]);
    expect(overlayZ).toBeGreaterThan(0);
    expect(popoverZ).toBeGreaterThan(overlayZ);
  });

  it("disables focused-layer animation for reduced motion", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.fn-input-paper/s);
  });
});
