use super::rig_adapter::{
    client::CompletionClient,
    providers::{anthropic, deepseek, moonshot, openai, zai},
    ModelHandle,
};
use crate::config::{AiProviderConfig, AiProviderId};

const ZHIPU_CHINA_BASE_URL: &str = "https://open.bigmodel.cn/api/paas/v4";

#[derive(Clone)]
pub struct AgentModel {
    pub handle: ModelHandle,
    secret: String,
}

impl AgentModel {
    pub fn sanitize_error(&self, error: impl ToString) -> String {
        sanitize_agent_error(&error.to_string(), &[&self.secret])
    }
}

pub fn build_agent_model(
    provider: AiProviderId,
    config: &AiProviderConfig,
) -> Result<AgentModel, String> {
    if !provider.is_supported() {
        return Err("未知的 AI 提供商".into());
    }
    let config = config.normalized_for(provider)?;
    let model = config.model.clone();
    let key = config.api_key.clone();
    let handle = match provider {
        AiProviderId::Openai if config.base_url.is_some() => {
            let client = openai::CompletionsClient::builder()
                .api_key(key.clone())
                .base_url(config.base_url.as_deref().unwrap_or_default())
                .build()
                .map_err(|error| sanitize_agent_error(&error.to_string(), &[&key]))?;
            ModelHandle::named("openai-compatible", client.completion_model(&model))
        }
        AiProviderId::Openai => {
            let client = openai::Client::builder()
                .api_key(key.clone())
                .build()
                .map_err(|error| sanitize_agent_error(&error.to_string(), &[&key]))?;
            ModelHandle::named("openai", client.completion_model(&model))
        }
        AiProviderId::Anthropic => {
            let mut builder = anthropic::Client::builder().api_key(key.clone());
            if let Some(base_url) = config.base_url.as_deref() {
                builder = builder.base_url(base_url);
            }
            let client = builder
                .build()
                .map_err(|error| sanitize_agent_error(&error.to_string(), &[&key]))?;
            ModelHandle::named("anthropic", client.completion_model(&model))
        }
        AiProviderId::Deepseek => {
            let client = deepseek::Client::builder()
                .api_key(key.clone())
                .build()
                .map_err(|error| sanitize_agent_error(&error.to_string(), &[&key]))?;
            ModelHandle::named("deepseek", client.completion_model(&model))
        }
        AiProviderId::Kimi => {
            let client = moonshot::Client::builder()
                .api_key(key.clone())
                .china()
                .build()
                .map_err(|error| sanitize_agent_error(&error.to_string(), &[&key]))?;
            ModelHandle::named("kimi", client.completion_model(&model))
        }
        AiProviderId::Zhipu => {
            let client = zai::Client::builder()
                .api_key(key.clone())
                .base_url(ZHIPU_CHINA_BASE_URL)
                .build()
                .map_err(|error| sanitize_agent_error(&error.to_string(), &[&key]))?;
            ModelHandle::named("zhipu", client.completion_model(&model))
        }
        AiProviderId::Unsupported => return Err("未知的 AI 提供商".into()),
    };
    Ok(AgentModel {
        handle,
        secret: key,
    })
}

pub fn sanitize_agent_error(message: &str, secrets: &[&str]) -> String {
    let mut output = message.to_string();
    for secret in secrets.iter().copied().filter(|secret| secret.len() >= 4) {
        output = output.replace(secret, "[已隐藏]");
    }
    let patterns = [
        r"(?i)(?:sk-|key-)[A-Za-z0-9._-]{6,}",
        r"(?i)(authorization|api[_ -]?key|access[_ -]?token|token)\s*[:=]\s*[^\s&]+",
        r"(?i)([?&](?:api[_-]?key|access[_-]?token|token|key)=)[^&\s]+",
        r"(https?://)[^\s/@:]+:[^\s/@]+@",
    ];
    for pattern in patterns {
        if let Ok(regex) = regex::Regex::new(pattern) {
            output = regex.replace_all(&output, "$1[已隐藏]").into_owned();
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_hide_explicit_and_url_secrets() {
        let value = sanitize_agent_error(
            "authorization: secret-value https://u:p@example.test?api_key=abcdefghi",
            &["secret-value"],
        );
        assert!(!value.contains("secret-value"));
        assert!(!value.contains("abcdefghi"));
        assert!(!value.contains("u:p"));
    }

    #[test]
    fn all_five_product_providers_build_without_network_access() {
        for provider in AiProviderId::ALL {
            let config = AiProviderConfig {
                api_key: "test-key".into(),
                model: "test-model".into(),
                base_url: None,
            };
            assert!(build_agent_model(provider, &config).is_ok(), "{provider:?}");
        }
        assert!(
            build_agent_model(AiProviderId::Unsupported, &AiProviderConfig::default()).is_err()
        );
    }

    #[test]
    fn openai_custom_base_url_uses_the_compatible_client_path() {
        let config = AiProviderConfig {
            api_key: "test-key".into(),
            model: "qwen".into(),
            base_url: Some("https://dashscope.aliyuncs.com/compatible-mode/v1".into()),
        };
        assert!(build_agent_model(AiProviderId::Openai, &config).is_ok());
    }
}
