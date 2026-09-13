import { startNoteApp } from "./note-app";
import { getConfig } from "./notes-state";
import { initializeAppearance } from "../shared/appearance";

// WebdriverIO 原生诊断桥：仅当以 VITE_WDIO=1 启动时（npm run review:native:doctor）注入
// @wdio/tauri-plugin，让 @wdio/tauri-service 能在 webview 内执行 JS、读取 console
// 并管理窗口。release/普通构建下此分支被 tree-shake，不进产物。
if (import.meta.env.VITE_WDIO === "1") {
  void import("@wdio/tauri-plugin");
}

async function boot() {
  const root = document.querySelector<HTMLElement>("#app")!;
  root.textContent = "正在启动 FloatNote…";
  try {
    await getConfig();
    initializeAppearance();
    await startNoteApp();
  } catch (reason) {
    console.error("Startup failed", reason);
    root.replaceChildren();
    const message = document.createElement("p");
    message.textContent = "无法完成启动，请重试。";
    const retry = document.createElement("button");
    retry.textContent = "重试";
    retry.onclick = () => void boot();
    root.append(message, retry);
  }
}
void boot();
