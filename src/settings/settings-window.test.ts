import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);
const settings = config.app.windows.find((window: { label: string }) => window.label === "settings");
const main = config.app.windows.find((window: { label: string }) => window.label === "main");
const windowsConfig = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.windows.conf.json", import.meta.url), "utf8"),
);

describe("Windows window shell", () => {
  it("creates borderless windows while preserving every base window option", () => {
    // Tauri replaces app.windows as a whole when merging platform configuration.
    expect(windowsConfig.app.windows).toEqual(config.app.windows.map(
      (window: { label: string }) => ["main", "settings"].includes(window.label)
        ? { ...window, decorations: false }
        : window,
    ));
  });
});

describe("main window shell", () => {
  it("stays hidden until the native page-load hook can reveal the startup shell", () => {
    expect(main.visible).toBe(false);
  });
});

describe("settings window shell", () => {
  it("uses the approved native, resizable dimensions", () => {
    expect(settings).toMatchObject({
      width: 780,
      height: 620,
      minWidth: 720,
      minHeight: 520,
      decorations: true,
      resizable: true,
      maximizable: true,
      titleBarStyle: "Overlay",
      hiddenTitle: true,
    });
  });
});
