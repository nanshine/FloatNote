import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { withAppState } from "../platform/startup";

export type Theme = "system" | "light" | "dark";

export function normalizeTheme(value: unknown): Theme {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function applyAppearance(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function initializeAppearance(): void {
  applyAppearance("system");
  void (async () => {
    let receivedThemeEvent = false;
    await listen<unknown>("theme-changed", (event) => {
      receivedThemeEvent = true;
      applyAppearance(normalizeTheme(event.payload));
    });
    try {
      const config = await withAppState(() => invoke<{ theme?: unknown }>("get_config"));
      if (!receivedThemeEvent) applyAppearance(normalizeTheme(config.theme));
    } catch {
      // Keep the safe system default if configuration is not available yet.
    }
  })();
}
