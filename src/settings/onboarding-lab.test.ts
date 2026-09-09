// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountOnboardingSettings } from "./onboarding-lab";
import { setOnboardingState } from "../platform/onboarding";

vi.mock("../platform/onboarding", () => ({
  replayOnboardingState: () => ({ version: 1, status: "in_progress", step: "welcome", capture_succeeded: false }),
  setOnboardingState: vi.fn(),
  setOnboardingPreview: vi.fn(),
}));

afterEach(() => { document.body.replaceChildren(); vi.resetAllMocks(); });

describe("onboarding settings", () => {
  it("shows restart failures in production without exposing the debug lab", async () => {
    vi.mocked(setOnboardingState).mockRejectedValue(new Error("无法保存引导进度"));
    const root = document.createElement("div");
    document.body.append(root);
    mountOnboardingSettings(root, false);
    root.querySelector<HTMLButtonElement>('[data-action="restart"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain("无法保存引导进度"));
    expect(root.querySelector(".onboarding-lab")).toBeNull();
  });
});
