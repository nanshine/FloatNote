import "@phosphor-icons/web/regular";
import { invoke } from "@tauri-apps/api/core";
import { initializeAppearance } from "../shared/appearance";
import { createEmptyAiSettings } from "./provider-profiles";
import { mountProviderSettings } from "./provider-settings";
import { mountGeneralSettings } from "./general";
import { mountSkills } from "./skills";
import { mountShortcutSettings } from "./shortcuts";
import { mountTabs, settingsShellMarkup } from "./shell";
import {
  mountCaptionButtons,
  mountResizeEdges,
  wireDragRegionToggleMaximize,
} from "../shared/ui/window-caption";
import type { Config } from "./types";
import { mountOutputMode } from "./output-mode";
import { connectSettingsNavigation } from "./navigation";
import { getRuntimeProfile } from "../platform/onboarding";
import { mountOnboardingSettings } from "./onboarding-lab";

const app = document.querySelector<HTMLElement>("#app")!;
let disconnectPermission: (() => void) | null = null;
let disconnectNavigation: (() => void) | null = null;

async function render(): Promise<void> {
  initializeAppearance();
  try {
    const config = await invoke<Config>("get_config");
    config.disabled_skills ??= [];
    config.ai_settings ??= createEmptyAiSettings();
    config.assistant_output_mode = config.assistant_output_mode === "detailed" ? "detailed" : "compact";
    disconnectPermission?.();
    app.innerHTML = settingsShellMarkup();
    disconnectNavigation?.();
    disconnectNavigation = await connectSettingsNavigation(mountTabs(app));
    // Windows：系统标题栏已去除，补自绘 min/max/close、双击最大化与边缘缩放。
    const titlebar = app.querySelector<HTMLElement>(".settings-titlebar")!;
    mountCaptionButtons(titlebar);
    wireDragRegionToggleMaximize(titlebar.querySelector<HTMLElement>(".titlebar-drag")!);
    mountResizeEdges();
    const save = () => invoke<void>("set_config", { newConfig: config });
    mountGeneralSettings(app.querySelector<HTMLElement>("#general-settings")!, config, save);
    const runtime = await getRuntimeProfile();
    mountOnboardingSettings(app.querySelector<HTMLElement>("#onboarding-settings")!, runtime.isDebug);
    mountProviderSettings(app.querySelector<HTMLElement>("#provider-settings")!, config.ai_settings, {
      saveProvider: (providerId, providerConfig) => invoke("save_ai_provider", { providerId, providerConfig }),
      setActiveProvider: (providerId) => invoke("set_active_ai_provider", { providerId }),
    });
    mountOutputMode(app.querySelector<HTMLElement>("#output-mode-settings")!, config, (mode) =>
      invoke("set_assistant_output_mode", { mode }));
    mountSkills(
      app.querySelector<HTMLElement>("#skills")!,
      app.querySelector<HTMLButtonElement>("#import-skill")!,
      app.querySelector<HTMLElement>("#skills-notice")!,
      config,
      save,
    );
    disconnectPermission = mountShortcutSettings(app.querySelector<HTMLElement>("#shortcut-settings")!, config);
  } catch (reason) {
    app.innerHTML = `<main class="settings-load-error" role="alert"><strong>无法载入设置</strong><p>${String(reason)}</p><button type="button" id="retry-settings">重试</button></main>`;
    app.querySelector<HTMLButtonElement>("#retry-settings")!.onclick = () => void render();
  }
}

void render();
