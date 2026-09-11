import { describe, expect, it } from "vitest";
import {
  createEmptyAiSettings,
  isProviderConfigured,
  normalizeProviderDraft,
  PROVIDER_PROFILES,
  validateProviderDraft,
} from "./provider-profiles";

describe("AI provider profiles", () => {
  it("offers exactly the five fixed providers in product order", () => {
    expect(PROVIDER_PROFILES.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "openai", label: "OpenAI API" },
      { id: "deepseek", label: "DeepSeek API" },
      { id: "anthropic", label: "Anthropic API" },
      { id: "kimi", label: "Kimi API" },
      { id: "zhipu", label: "智谱 API" },
    ]);
  });

  it("starts every model empty with AI disabled", () => {
    const settings = createEmptyAiSettings();
    expect(settings.activeProviderId).toBeNull();
    expect(Object.values(settings.providers)).toEqual(
      Array.from({ length: 5 }, () => ({ apiKey: "", model: "" })),
    );
  });

  it("only exposes Base URL for OpenAI and Anthropic", () => {
    expect(PROVIDER_PROFILES.filter((profile) => profile.allowsBaseUrl).map((profile) => profile.id))
      .toEqual(["openai", "anthropic"]);
  });

  it("requires a trimmed API key and model", () => {
    expect(validateProviderDraft("openai", { apiKey: " ", model: " " })).toEqual({
      apiKey: "请输入 API Key",
      model: "请输入模型 ID",
    });
    expect(isProviderConfigured({ apiKey: " key ", model: " model " })).toBe(true);
  });

  it("accepts only HTTP URLs and removes trailing slashes while preserving paths", () => {
    expect(validateProviderDraft("openai", {
      apiKey: "key",
      model: "model",
      baseUrl: "ftp://proxy.example/v1",
    })).toEqual({ baseUrl: "Base URL 必须是 http 或 https 地址" });
    expect(normalizeProviderDraft("openai", {
      apiKey: " key ",
      model: " model ",
      baseUrl: " https://proxy.example/v1/// ",
    })).toEqual({ apiKey: "key", model: "model", baseUrl: "https://proxy.example/v1" });
  });

  it("drops Base URL for providers that use a fixed official endpoint", () => {
    expect(normalizeProviderDraft("kimi", {
      apiKey: "key",
      model: "model",
      baseUrl: "https://ignored.example",
    })).toEqual({ apiKey: "key", model: "model" });
  });
});
