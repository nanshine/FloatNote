import { startNoteApp } from "./note-app";
import { initializeAppearance } from "../shared/appearance";

// WebdriverIO 原生诊断桥：仅当以 VITE_WDIO=1 启动时（npm run review:native:doctor）注入
// @wdio/tauri-plugin，让 @wdio/tauri-service 能在 webview 内执行 JS、读取 console
// 并管理窗口。release/普通构建下此分支被 tree-shake，不进产物。
if (import.meta.env.VITE_WDIO === "1") {
  void import("@wdio/tauri-plugin");
}

void initializeAppearance();
void startNoteApp();
