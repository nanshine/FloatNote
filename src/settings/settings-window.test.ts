import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);
const settings = config.app.windows.find((window: { label: string }) => window.label === "settings");
const main = config.app.windows.find((window: { label: string }) => window.label === "main");

describe("main window shell", () => {
  it("is visible on every application launch", () => {
    expect(main.visible).toBe(true);
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
