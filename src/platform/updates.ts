import { Channel, invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";

export interface UpdateInfo {
  configured: boolean;
  currentVersion: string;
  version: string | null;
  notes: string | null;
}
export interface UpdateProgress { downloaded: number; total: number | null }
export interface UpdateStatus {
  phase: "idle" | "checking" | "available" | "downloading" | "preparing" | "installing" | "error";
  info?: UpdateInfo;
  progress?: UpdateProgress;
  error?: string;
}
export type UpdateRequest = "check" | "install" | "snapshot";
export const checkUpdate = () => invoke<UpdateInfo>("update_check");
export const downloadUpdate = (onProgress: (progress: UpdateProgress) => void) => {
  const progress = new Channel<UpdateProgress>();
  progress.onmessage = onProgress;
  return invoke<void>("update_download", { progress });
};
export const prepareUpdate = () => invoke<void>("update_prepare");
export const installUpdate = () => invoke<void>("update_install");
export const releaseUpdate = () => invoke<void>("update_release");
export const requestUpdate = (request: UpdateRequest) => emitTo("main", "update-request", request);
export const onUpdateRequest = (handler: (request: UpdateRequest) => void) =>
  listen<UpdateRequest>("update-request", ({ payload }) => handler(payload));
export const publishUpdateStatus = (status: UpdateStatus) => emit("update-status", status);
export const onUpdateStatus = (handler: (status: UpdateStatus) => void) =>
  listen<UpdateStatus>("update-status", ({ payload }) => handler(payload));

export const showUpdateSettings = () => emitTo("settings", "update-show-settings");
export const onShowUpdateSettings = (handler: () => void) => listen("update-show-settings", handler);
