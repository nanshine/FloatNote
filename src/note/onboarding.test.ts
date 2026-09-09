import { describe, expect, it } from "vitest";
import { coachPlacement, splitExpansionTarget } from "./onboarding";
import { readFileSync } from "node:fs";

describe("onboarding geometry", () => {
  it("flips above an anchor near the viewport bottom and clamps horizontally", () => {
    const anchor = { left: 370, top: 480, right: 390, bottom: 500, width: 20, height: 20 } as DOMRect;
    expect(coachPlacement(anchor, { width: 260, height: 160 }, { width: 400, height: 520 })).toEqual({ left: 132, top: 308, side: "bottom" });
  });
  it("places the coach beside a panel when neither vertical side has room", () => {
    const anchor = { left: 520, top: 90, right: 820, bottom: 180, width: 300, height: 90 } as DOMRect;
    expect(coachPlacement(anchor, { width: 320, height: 203 }, { width: 840, height: 377 })).toEqual({ left: 188, top: 90, side: "right" });
  });
  it("expands to 840 logical pixels and rejects undersized work areas", () => {
    expect(splitExpansionTarget(380, 1200)).toBe(840);
    expect(splitExpansionTarget(900, 1200)).toBe(900);
    expect(splitExpansionTarget(380, 799)).toBeNull();
  });
  it("disables onboarding movement and target pulses for reduced motion", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.onboarding-content-card,[\s\S]*\.onboarding-coach,[\s\S]*\.onboarding-target\s*\{\s*animation:\s*none;/);
  });
});
