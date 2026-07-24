// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EDITOR_FONT_SIZE,
  EDITOR_FONT_SIZE_STORAGE_KEY,
  adjustEditorFontSize,
  initializeEditorFontSize,
  resetEditorFontSize,
} from "./font-size";

describe("editor font size", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty("--editor-font");
  });

  it("initializes from the persisted size", () => {
    localStorage.setItem(EDITOR_FONT_SIZE_STORAGE_KEY, "18");

    expect(initializeEditorFontSize()).toBe(18);
    expect(document.documentElement.style.getPropertyValue("--editor-font")).toBe("18px");
  });

  it("falls back to the default for invalid persisted data", () => {
    localStorage.setItem(EDITOR_FONT_SIZE_STORAGE_KEY, "not-a-size");

    expect(initializeEditorFontSize()).toBe(DEFAULT_EDITOR_FONT_SIZE);
    expect(document.documentElement.style.getPropertyValue("--editor-font")).toBe("15px");
  });

  it("adjusts in one-pixel steps and persists the result", () => {
    initializeEditorFontSize();

    expect(adjustEditorFontSize(1)).toBe(16);
    expect(localStorage.getItem(EDITOR_FONT_SIZE_STORAGE_KEY)).toBe("16");
    expect(document.documentElement.style.getPropertyValue("--editor-font")).toBe("16px");
  });

  it("clamps adjustments to the supported range", () => {
    localStorage.setItem(EDITOR_FONT_SIZE_STORAGE_KEY, "24");
    initializeEditorFontSize();
    expect(adjustEditorFontSize(1)).toBe(24);

    localStorage.setItem(EDITOR_FONT_SIZE_STORAGE_KEY, "12");
    initializeEditorFontSize();
    expect(adjustEditorFontSize(-1)).toBe(12);
  });

  it("resets and persists the default size", () => {
    localStorage.setItem(EDITOR_FONT_SIZE_STORAGE_KEY, "20");
    initializeEditorFontSize();

    expect(resetEditorFontSize()).toBe(DEFAULT_EDITOR_FONT_SIZE);
    expect(localStorage.getItem(EDITOR_FONT_SIZE_STORAGE_KEY)).toBe("15");
  });
});
