import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type OnboardingStatus = "not_started" | "in_progress" | "completed" | "dismissed";
export type OnboardingStep = "welcome" | "capture" | "writing" | "tasks" | "split" | "assistant" | "access";
export type CapturePermissionState = "not_required" | "required" | "granted";
export type OnboardingPreviewScene = "welcome" | "capture-permission" | "capture-ready" | "capture-success" | "writing" | "tasks-closed" | "tasks-open" | "split-narrow" | "split-wide" | "assistant-unconfigured" | "assistant-configured-empty" | "access";

export interface OnboardingState {
  version: 1;
  status: OnboardingStatus;
  step: OnboardingStep;
  capture_succeeded: boolean;
}

export interface RuntimeProfile { name: string; isDebug: boolean; root: string | null }

export const replayOnboardingState = (): OnboardingState => ({ version: 1, status: "in_progress", step: "welcome", capture_succeeded: false });
export const getOnboardingState = () => invoke<OnboardingState>("get_onboarding_state");
export const setOnboardingState = (onboarding: OnboardingState) => invoke<OnboardingState>("set_onboarding_state", { onboarding });
export const getRuntimeProfile = () => invoke<RuntimeProfile>("get_runtime_profile");
export const getOnboardingPreview = () => invoke<OnboardingPreviewScene | null>("get_onboarding_preview");
export const setOnboardingPreview = (scene: OnboardingPreviewScene | null) => invoke<void>("set_onboarding_preview", { scene });
export const getCapturePermissionState = () => invoke<CapturePermissionState>("get_capture_permission_state");
export const requestCapturePermission = () => invoke<CapturePermissionState>("request_capture_permission");
export const onOnboardingChanged = (callback: (state: OnboardingState) => void): Promise<UnlistenFn> => listen<OnboardingState>("onboarding://changed", (event) => callback(event.payload));
export const onOnboardingPreviewChanged = (callback: (scene: OnboardingPreviewScene | null) => void): Promise<UnlistenFn> => listen<OnboardingPreviewScene | null>("onboarding://preview-changed", (event) => callback(event.payload));

export const openSettings = () => invoke<void>("open_settings");
