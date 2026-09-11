import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Listen before consuming the retained target, covering startup and warm windows. */
export async function connectSettingsNavigation(activate: (name: string) => void): Promise<() => void> {
  const consume = async () => {
    const target = await invoke<string | null>("take_settings_navigation");
    if (target) activate(target);
  };
  const unlisten = await listen("settings://navigate", () => {
    void consume().catch((error) => console.error("无法切换设置分类", error));
  });
  try {
    await consume();
  } catch (error) {
    unlisten();
    throw error;
  }
  return unlisten;
}
