import { invoke } from "@tauri-apps/api/core";

export type AiReadiness =
  | { status: "unconfigured" | "disabled" | "runtime_unavailable" | "ready" }
  | { status: "incomplete"; message: string };

export const getAiReadiness = () => invoke<AiReadiness>("get_ai_readiness");
export const retryAiConfiguration = () => invoke<AiReadiness>("retry_ai_configuration");
export const openAiSettings = () => invoke<void>("open_ai_settings");
