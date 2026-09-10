import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();

/** CSS files that should consume design tokens, not raw accent hex literals.
 * Nested code-editor highlighting is a separate concern. `primitives.css`
 * defines the ramp itself. */
const tokenizedCss = [
  "src/styles.css",
  "src/assistant/styles.css",
  "src/settings/styles.css",
  "src/popup/styles.css",
  "src/history/styles.css",
];

const windowHtml = ["index.html", "settings.html", "popup.html", "history.html"];

describe("design tokens", () => {
  it("keeps the explicit dark theme complete and on the accessible reading palette", () => {
    const s = readFileSync(resolve(root, "src/styles/semantic.css"), "utf8");
    const dark = s.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/)?.[1] ?? "";

    for (const declaration of [
      "--color-bg: var(--dark-surface-base)",
      "--color-surface: var(--dark-surface-reading)",
      "--color-surface-2: var(--dark-surface-chrome)",
      "--color-surface-3: var(--dark-surface-elevated)",
      "--color-overlay: var(--dark-overlay)",
      "--color-text: var(--dark-text-primary)",
      "--color-text-muted: var(--dark-text-secondary)",
      "--color-text-subtle: var(--dark-text-tertiary)",
      "--color-danger: var(--danger-500)",
      "--color-danger-hover: var(--danger-400)",
      "--color-danger-fill: rgba(248, 113, 113, 0.14)",
      "--color-danger-fill-strong: rgba(248, 113, 113, 0.22)",
    ]) {
      expect(dark).toContain(declaration);
    }
  });

  it("defines the recommended dark reading surfaces and text ramp", () => {
    const p = readFileSync(resolve(root, "src/styles/primitives.css"), "utf8");
    for (const declaration of [
      "--dark-surface-base: #1e1e1e",
      "--dark-surface-reading: #222325",
      "--dark-surface-chrome: #292a2d",
      "--dark-surface-elevated: #303136",
      "--dark-overlay: rgba(36, 37, 40, 0.96)",
      "--dark-text-primary: #e6e8eb",
      "--dark-text-secondary: #b4b9c2",
      "--dark-text-tertiary: #9299a5",
    ]) {
      expect(p).toContain(declaration);
    }
  });

  it("defines the full indigo ramp in primitives.css", () => {
    const p = readFileSync(resolve(root, "src/styles/primitives.css"), "utf8");
    for (const step of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]) {
      expect(p).toMatch(new RegExp(`--indigo-${step}:`));
    }
    // Locked primary + dark accent.
    expect(p).toContain("--indigo-600: #4f46e5");
    expect(p).toContain("--indigo-400: #818cf8");
  });

  it("exposes the accent semantic tokens in semantic.css", () => {
    const s = readFileSync(resolve(root, "src/styles/semantic.css"), "utf8");
    expect(s).toMatch(/--color-accent:\s*var\(--indigo-600\)/);
    expect(s).toMatch(/--color-accent-fill:/);
    expect(s).toMatch(/--color-focus-ring:/);
    // Dark block re-points accent to indigo-400.
    expect(s).toMatch(
      /@media \(prefers-color-scheme: dark\)[\s\S]*--color-accent:\s*var\(--indigo-400\)/,
    );
  });

  it("uses a single focus ring and lets text-editing surfaces opt into quiet focus", () => {
    const base = readFileSync(resolve(root, "src/styles/base.css"), "utf8");
    const globalFocus = base.match(/:where\(button,[\s\S]*?\):not\(\[data-focus-style="quiet"\]\):focus-visible\s*\{([^}]*)\}/)?.[1] ?? "";
    const quietFocus = base.match(/\[data-focus-style="quiet"\]:focus-visible\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(globalFocus).toMatch(/outline:\s*2px solid var\(--color-accent\)/);
    expect(globalFocus).not.toMatch(/box-shadow/);
    expect(quietFocus).toMatch(/outline:\s*none/);
    expect(quietFocus).toMatch(/box-shadow:\s*none/);
  });

  it("exposes the danger semantic tokens (mirroring accent, light + dark)", () => {
    const s = readFileSync(resolve(root, "src/styles/semantic.css"), "utf8");
    for (const tok of [
      "--color-danger:",
      "--color-danger-hover:",
      "--color-danger-fill:",
      "--color-danger-fill-strong:",
    ]) {
      expect(s).toMatch(new RegExp(tok));
    }
    // Dark block re-points danger text to the lighter shade.
    expect(s).toMatch(
      /@media \(prefers-color-scheme: dark\)[\s\S]*--color-danger:\s*var\(--danger-500\)/,
    );
    // primitives back the dark lighter shade.
    const p = readFileSync(resolve(root, "src/styles/primitives.css"), "utf8");
    expect(p).toContain("--danger-400:");
  });

  it("exposes a warning token for user-declined actions in both color schemes", () => {
    const s = readFileSync(resolve(root, "src/styles/semantic.css"), "utf8");
    expect(s).toMatch(/:root\s*\{[\s\S]*--color-warning:/);
    expect(s).toMatch(/@media \(prefers-color-scheme: dark\)[\s\S]*--color-warning:/);
  });

  it("has no residual accent/danger rgba literals in window CSS", () => {
    // After migration, hover/selected/focus-ring/danger fills in window
    // styles go through semantic tokens — no raw rgba(37,99,235)/danger ramps.
    const banned = [
      "rgba(37, 99, 235",
      "rgba(96, 165, 250",
      "rgba(59, 130, 246",
      "rgba(220, 38, 38",
      "rgba(239, 68, 68",
      "rgba(248, 113, 113",
    ];
    for (const f of tokenizedCss) {
      const css = readFileSync(resolve(root, f), "utf8").replace(
        /\/\*[\s\S]*?\*\//g,
        "",
      );
      for (const lit of banned) {
        expect(css).not.toMatch(new RegExp(lit.replace(/[()]/g, "\\$&")));
      }
    }
  });

  it("has no per-window dark @media block (dark is centralized in semantic.css)", () => {
    for (const f of tokenizedCss) {
      const css = readFileSync(resolve(root, f), "utf8").replace(
        /\/\*[\s\S]*?\*\//g,
        "",
      );
      expect(css).not.toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
    }
  });

  it("component layer never consumes primitives directly", () => {
    const c = readFileSync(resolve(root, "src/styles/components.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(c).not.toMatch(/var\(--indigo-/);
    expect(c).not.toMatch(/var\(--danger-/);
  });

  it("has no raw #2563eb accent literal in tokenized CSS (comments stripped)", () => {
    for (const f of tokenizedCss) {
      const css = readFileSync(resolve(root, f), "utf8").replace(
        /\/\*[\s\S]*?\*\//g,
        "",
      );
      expect(css).not.toMatch(/#2563eb/i);
    }
  });

  it("links index.css from every window HTML head", () => {
    for (const f of windowHtml) {
      const h = readFileSync(resolve(root, f), "utf8");
      expect(h).toMatch(/href="\/src\/styles\/index\.css"/);
    }
  });

  it("aggregates the four token layers in index.css (import-only)", () => {
    const idx = readFileSync(resolve(root, "src/styles/index.css"), "utf8");
    // No bare rules — only @import (CSS spec requires @import first).
    // 归一化 CRLF：Windows 检出会把 \r 留成行首字符，干扰 ^ 锚点判定。
    const lines = idx.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\r\n/g, "\n").trim();
    expect(lines).not.toMatch(/^[^@]/m);
    for (const layer of ["primitives", "semantic", "base", "components"]) {
      expect(idx).toContain(`@import "./${layer}.css"`);
    }
  });
});
