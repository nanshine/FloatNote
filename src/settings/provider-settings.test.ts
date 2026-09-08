// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyAiSettings, type AiProviderConfig } from "./provider-profiles";
import { mountProviderSettings } from "./provider-settings";

afterEach(() => {
  document.body.innerHTML = "";
});

function setup() {
  const root = document.createElement("div");
  document.body.append(root);
  const settings = createEmptyAiSettings();
  const saveProvider = vi.fn(async (_id: string, _config: AiProviderConfig) => undefined);
  const setActiveProvider = vi.fn(async (_id: string | null) => undefined);
  mountProviderSettings(root, settings, { saveProvider, setActiveProvider });
  return { root, settings, saveProvider, setActiveProvider };
}

describe("provider settings", () => {
  it("renders five fixed rows with explicit unconfigured states", () => {
    const { root } = setup();
    expect([...root.querySelectorAll<HTMLElement>("[data-provider-id]")].map((row) => row.dataset.providerId))
      .toEqual(["openai", "deepseek", "anthropic", "kimi", "zhipu"]);
    expect([...root.querySelectorAll(".provider-status")].map((node) => node.textContent))
      .toEqual(Array.from({ length: 5 }, () => "未配置"));
  });

  it("expands only one row without changing the active provider", () => {
    const { root, settings, setActiveProvider } = setup();
    root.querySelector<HTMLButtonElement>('[data-provider-expand="openai"]')!.click();
    expect(root.querySelector('[data-provider-form="openai"]')).not.toBeNull();
    root.querySelector<HTMLButtonElement>('[data-provider-expand="anthropic"]')!.click();
    expect(root.querySelector('[data-provider-form="openai"]')).toBeNull();
    expect(root.querySelector('[data-provider-form="anthropic"]')).not.toBeNull();
    expect(settings.activeProviderId).toBeNull();
    expect(setActiveProvider).not.toHaveBeenCalled();
  });

  it("uses text model input and only shows Base URL where allowed", () => {
    const { root } = setup();
    for (const provider of ["openai", "deepseek", "anthropic", "kimi", "zhipu"]) {
      root.querySelector<HTMLButtonElement>(`[data-provider-expand="${provider}"]`)!.click();
      expect(root.querySelector<HTMLInputElement>(`[data-provider-model="${provider}"]`)?.type).toBe("text");
      expect(Boolean(root.querySelector(`[data-provider-base-url="${provider}"]`)))
        .toBe(["openai", "anthropic"].includes(provider));
      expect(root.querySelector("select")).toBeNull();
    }
  });

  it("keeps save disabled until the draft is changed and valid", () => {
    const { root } = setup();
    root.querySelector<HTMLButtonElement>('[data-provider-expand="openai"]')!.click();
    const save = root.querySelector<HTMLButtonElement>('[data-provider-save="openai"]')!;
    expect(save.disabled).toBe(true);
    const key = root.querySelector<HTMLInputElement>('[data-provider-key="openai"]')!;
    const model = root.querySelector<HTMLInputElement>('[data-provider-model="openai"]')!;
    key.value = " key ";
    key.dispatchEvent(new Event("input", { bubbles: true }));
    model.value = " gpt-5 ";
    model.dispatchEvent(new Event("input", { bubbles: true }));
    expect(save.disabled).toBe(false);
  });

  it("saves normalized fields and then enables the configured switch", async () => {
    const { root, saveProvider } = setup();
    root.querySelector<HTMLButtonElement>('[data-provider-expand="openai"]')!.click();
    for (const [selector, value] of [
      ['[data-provider-key="openai"]', " key "],
      ['[data-provider-model="openai"]', " gpt-5 "],
      ['[data-provider-base-url="openai"]', " https://proxy.example/v1/// "],
    ]) {
      const input = root.querySelector<HTMLInputElement>(selector)!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    root.querySelector<HTMLButtonElement>('[data-provider-save="openai"]')!.click();
    await vi.waitFor(() => expect(saveProvider).toHaveBeenCalledWith("openai", {
      apiKey: "key",
      model: "gpt-5",
      baseUrl: "https://proxy.example/v1",
    }));
    expect(root.querySelector<HTMLInputElement>('[data-provider-toggle="openai"]')!.disabled).toBe(false);
    expect(root.querySelector('[data-provider-id="openai"] .provider-status')!.textContent).toBe("已配置");
  });

  it("keeps the old active provider when activation fails", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const settings = createEmptyAiSettings();
    settings.providers.openai = { apiKey: "a", model: "gpt-5" };
    settings.providers.kimi = { apiKey: "b", model: "kimi-k2.5" };
    settings.activeProviderId = "openai";
    const setActiveProvider = vi.fn(async () => { throw new Error("认证失败，请检查配置"); });
    mountProviderSettings(root, settings, { saveProvider: vi.fn(), setActiveProvider });
    root.querySelector<HTMLInputElement>('[data-provider-toggle="kimi"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('[data-provider-error="kimi"]')!.textContent)
      .toContain("认证失败"));
    expect(root.querySelector<HTMLInputElement>('[data-provider-toggle="openai"]')!.checked).toBe(true);
    expect(root.querySelector<HTMLInputElement>('[data-provider-toggle="kimi"]')!.checked).toBe(false);
  });

  it("activates exactly one configured provider at a time", async () => {
    const { root, settings, setActiveProvider } = setup();
    settings.providers.openai = { apiKey: "a", model: "gpt-5" };
    settings.providers.kimi = { apiKey: "b", model: "kimi-k2.5" };
    settings.activeProviderId = "openai";
    mountProviderSettings(root, settings, { saveProvider: vi.fn(), setActiveProvider });

    root.querySelector<HTMLInputElement>('[data-provider-toggle="kimi"]')!.click();
    await vi.waitFor(() => expect(setActiveProvider).toHaveBeenCalledWith("kimi"));

    expect(root.querySelector<HTMLInputElement>('[data-provider-toggle="openai"]')!.checked).toBe(false);
    expect(root.querySelector<HTMLInputElement>('[data-provider-toggle="kimi"]')!.checked).toBe(true);
  });

  it("retains an edited draft when saving fails", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const settings = createEmptyAiSettings();
    const saveProvider = vi.fn(async () => { throw new Error("网络错误"); });
    mountProviderSettings(root, settings, { saveProvider, setActiveProvider: vi.fn() });
    root.querySelector<HTMLButtonElement>('[data-provider-expand="openai"]')!.click();
    const key = root.querySelector<HTMLInputElement>('[data-provider-key="openai"]')!;
    const model = root.querySelector<HTMLInputElement>('[data-provider-model="openai"]')!;
    key.value = "draft-key";
    key.dispatchEvent(new Event("input", { bubbles: true }));
    model.value = "gpt-5";
    model.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-provider-save="openai"]')!.click();

    await vi.waitFor(() => expect(root.querySelector('[data-provider-error="openai"]')!.textContent).toContain("网络错误"));
    expect(root.querySelector<HTMLInputElement>('[data-provider-key="openai"]')!.value).toBe("draft-key");
  });

  it("allows the last active provider to be turned off", async () => {
    const { root, settings, setActiveProvider } = setup();
    settings.providers.openai = { apiKey: "a", model: "gpt-5" };
    settings.activeProviderId = "openai";
    mountProviderSettings(root, settings, { saveProvider: vi.fn(), setActiveProvider });
    root.querySelector<HTMLInputElement>('[data-provider-toggle="openai"]')!.click();
    await vi.waitFor(() => expect(setActiveProvider).toHaveBeenCalledWith(null));
    expect(settings.activeProviderId).toBeNull();
  });

  it("disables every provider switch while an activation is pending", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const settings = createEmptyAiSettings();
    settings.providers.openai = { apiKey: "a", model: "gpt-5" };
    settings.providers.kimi = { apiKey: "b", model: "kimi-k2.5" };
    let resolveActivation!: () => void;
    const setActiveProvider = vi.fn(() => new Promise<void>((resolve) => {
      resolveActivation = resolve;
    }));
    mountProviderSettings(root, settings, { saveProvider: vi.fn(), setActiveProvider });

    root.querySelector<HTMLInputElement>('[data-provider-toggle="openai"]')!.click();
    await vi.waitFor(() => expect(setActiveProvider).toHaveBeenCalledWith("openai"));
    expect(root.querySelector<HTMLInputElement>('[data-provider-toggle="openai"]')!.disabled).toBe(true);
    expect(root.querySelector<HTMLInputElement>('[data-provider-toggle="kimi"]')!.disabled).toBe(true);

    resolveActivation();
    await vi.waitFor(() => expect(settings.activeProviderId).toBe("openai"));
  });
});
