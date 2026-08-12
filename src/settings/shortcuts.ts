import { invoke } from "@tauri-apps/api/core";
import { findShortcutConflicts, formatComboHtml, WINDOW_SHORTCUT_DEFAULTS, WINDOW_SHORTCUT_IDS, WINDOW_SHORTCUT_LABELS, type ShortcutFieldId, type WindowShortcutId } from "../shared/shortcuts";
import { KeyRecorder } from "./key-recorder";
import type { Config } from "./types";

export function mountShortcutSettings(root: HTMLElement, config: Config): void {
  root.innerHTML = `<section class="settings-section" aria-labelledby="global-shortcuts-title"><h2 id="global-shortcuts-title">系统快捷键</h2><div class="settings-card">
    ${shortcutMarkup("capture", "划词采集", config.shortcut_capture)}
    ${shortcutMarkup("toggle", "显示 / 隐藏窗口", config.shortcut_toggle)}
  </div></section>
  <section class="settings-section" aria-labelledby="popup-trigger-title"><h2 id="popup-trigger-title">选中文字弹窗</h2><div class="settings-card">
    <div class="settings-line"><div><label for="auto-popup-mode"><strong>触发方式</strong></label><small>选中文字后自动弹出，或手动按快捷键唤出</small></div><span class="select-wrap"><select id="auto-popup-mode" class="fn-control"><option value="auto">自动弹出</option><option value="shortcut">快捷键</option><option value="off">关闭</option></select></span></div>
    <div id="popup-shortcut-row" class="popup-shortcut-row" ${config.auto_popup_mode === "shortcut" ? "" : "hidden"}>${shortcutMarkup("popup", "打开选中文字弹窗", config.shortcut_popup)}</div>
    <p id="popup-mode-error" class="settings-inline-error" role="alert"></p>
  </div></section>
  <section class="settings-section" aria-labelledby="window-shortcuts-title"><h2 id="window-shortcuts-title">窗口快捷键</h2><div class="settings-card">${WINDOW_SHORTCUT_IDS.map((id) => shortcutMarkup(id, WINDOW_SHORTCUT_LABELS[id], config.window_shortcuts?.[id] ?? WINDOW_SHORTCUT_DEFAULTS[id])).join("")}</div></section>`;

  const recorders = {} as Record<ShortcutFieldId, KeyRecorder>;
  const globalIds = ["capture", "toggle", "popup"] as const;
  const readGlobals = () => ({ capture: recorders.capture.value, toggle: recorders.toggle.value, popup: recorders.popup.value });
  const apply = async () => {
    const windows = Object.fromEntries(WINDOW_SHORTCUT_IDS.map((id) => [id, recorders[id].value])) as Record<WindowShortcutId, string>;
    const globals = readGlobals();
    const conflicts = findShortcutConflicts(windows, globals);
    root.querySelectorAll<HTMLElement>(".shortcut-error").forEach((element) => {
      const conflict = conflicts[element.dataset.shortcut as ShortcutFieldId];
      element.textContent = conflict?.message ?? "";
      const line = element.closest(".shortcut-line");
      line?.classList.toggle("has-error", Boolean(conflict));
      line?.querySelector<HTMLElement>(".key-recorder")?.setAttribute("aria-invalid", String(Boolean(conflict)));
    });
    if (Object.keys(conflicts).length) return;
    try {
      await invoke("apply_shortcuts", { ...globals, windowShortcuts: windows });
      config.shortcut_capture = globals.capture;
      config.shortcut_toggle = globals.toggle;
      config.shortcut_popup = globals.popup;
      config.window_shortcuts = windows;
    } catch (reason) {
      root.querySelector<HTMLElement>(".shortcut-error")!.textContent = `无法应用快捷键：${String(reason)}`;
    }
  };
  [...globalIds, ...WINDOW_SHORTCUT_IDS].forEach((id) => {
    const initial = id in config.window_shortcuts ? config.window_shortcuts[id as WindowShortcutId] : config[`shortcut_${id}` as "shortcut_capture" | "shortcut_toggle" | "shortcut_popup"];
    recorders[id] = new KeyRecorder(root.querySelector<HTMLElement>(`#recorder-${id}`)!, initial, () => void apply());
  });

  const mode = root.querySelector<HTMLSelectElement>("#auto-popup-mode")!;
  const popupRow = root.querySelector<HTMLElement>("#popup-shortcut-row")!;
  const modeError = root.querySelector<HTMLElement>("#popup-mode-error")!;
  mode.value = config.auto_popup_mode;
  mode.addEventListener("change", async () => {
    const previous = config.auto_popup_mode;
    popupRow.hidden = mode.value !== "shortcut";
    modeError.textContent = "";
    try {
      await invoke("set_auto_popup_mode", { mode: mode.value });
      config.auto_popup_mode = mode.value;
    } catch (reason) {
      mode.value = previous;
      popupRow.hidden = previous !== "shortcut";
      modeError.textContent = `无法更新触发方式：${String(reason)}`;
    }
  });
}

function shortcutMarkup(id: ShortcutFieldId, label: string, value: string): string {
  return `<div class="shortcut-line"><div><strong>${label}</strong><span id="shortcut-error-${id}" class="shortcut-error" data-shortcut="${id}" role="alert"></span></div><div id="recorder-${id}" class="key-recorder" role="button" tabindex="0" aria-label="录制${label}快捷键" aria-describedby="shortcut-error-${id}"><span class="key-recorder-label">${formatComboHtml(value)}</span></div></div>`;
}
