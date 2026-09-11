export type AiProviderId =
  | "openai"
  | "deepseek"
  | "anthropic"
  | "kimi"
  | "zhipu";

export interface AiProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export interface AiSettings {
  providers: Record<AiProviderId, AiProviderConfig>;
  activeProviderId: AiProviderId | null;
}

export interface ProviderProfile {
  id: AiProviderId;
  label: string;
  mark: string;
  allowsBaseUrl: boolean;
}

export type ProviderDraftErrors = Partial<Record<keyof AiProviderConfig, string>>;

export const PROVIDER_PROFILES: readonly ProviderProfile[] = [
  { id: "openai", label: "OpenAI API", mark: "AI", allowsBaseUrl: true },
  { id: "deepseek", label: "DeepSeek API", mark: "DS", allowsBaseUrl: false },
  { id: "anthropic", label: "Anthropic API", mark: "AN", allowsBaseUrl: true },
  { id: "kimi", label: "Kimi API", mark: "K", allowsBaseUrl: false },
  { id: "zhipu", label: "智谱 API", mark: "智", allowsBaseUrl: false },
];

export function getProviderProfile(id: AiProviderId): ProviderProfile {
  return PROVIDER_PROFILES.find((profile) => profile.id === id)!;
}

export function createEmptyAiSettings(): AiSettings {
  return {
    providers: Object.fromEntries(
      PROVIDER_PROFILES.map(({ id }) => [id, { apiKey: "", model: "" }]),
    ) as Record<AiProviderId, AiProviderConfig>,
    activeProviderId: null,
  };
}

export function isProviderConfigured(config: AiProviderConfig): boolean {
  return config.apiKey.trim().length > 0 && config.model.trim().length > 0;
}

export function validateProviderDraft(
  providerId: AiProviderId,
  draft: AiProviderConfig,
): ProviderDraftErrors {
  const errors: ProviderDraftErrors = {};
  if (!draft.apiKey.trim()) errors.apiKey = "请输入 API Key";
  if (!draft.model.trim()) errors.model = "请输入模型 ID";
  const baseUrl = draft.baseUrl?.trim();
  if (getProviderProfile(providerId).allowsBaseUrl && baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        errors.baseUrl = "Base URL 必须是 http 或 https 地址";
      }
    } catch {
      errors.baseUrl = "Base URL 必须是 http 或 https 地址";
    }
  }
  return errors;
}

export function normalizeProviderDraft(
  providerId: AiProviderId,
  draft: AiProviderConfig,
): AiProviderConfig {
  const normalized: AiProviderConfig = {
    apiKey: draft.apiKey.trim(),
    model: draft.model.trim(),
  };
  if (getProviderProfile(providerId).allowsBaseUrl) {
    const baseUrl = draft.baseUrl?.trim().replace(/\/+$/, "");
    if (baseUrl) normalized.baseUrl = baseUrl;
  }
  return normalized;
}
