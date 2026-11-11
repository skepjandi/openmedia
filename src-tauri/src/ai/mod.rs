pub mod activity;
pub mod agent;
pub mod anthropic;
pub mod chats;
pub mod connection;
pub mod hub;
pub mod openai;
pub mod patch;
pub mod prompt;
pub mod provider;
pub mod redact;
pub mod snapshot;

use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

use crate::error::{Error, Result};

pub const MAX_PROVIDERS: usize = 8;
const MAX_NAME_CHARS: usize = 30;
const MAX_MODEL_CHARS: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    Anthropic,
    OpenAiCompatible,
}

/// Non-secret provider settings. The API key is never part of this: it lives in the secret store
/// under the provider's id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: Uuid,
    pub name: String,
    pub kind: ProviderKind,
    pub base_url: String,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInput {
    pub id: Option<Uuid>,
    pub name: String,
    pub kind: ProviderKind,
    pub base_url: String,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    pub providers: Vec<ProviderConfig>,
    pub active_id: Option<Uuid>,
}

impl ProviderConfig {
    pub fn from_input(input: ProviderInput) -> Result<Self> {
        let invalid = |why: &str| Error::InvalidProvider(why.to_owned());
        let name = input.name.trim();
        if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
            return Err(invalid("the name must be 1-30 characters"));
        }
        let model = input
            .model
            .map(|m| m.trim().to_owned())
            .filter(|m| !m.is_empty());
        if let Some(model) = &model
            && (model.chars().count() > MAX_MODEL_CHARS || model.chars().any(char::is_control))
        {
            return Err(invalid("the model name is not valid"));
        }
        Ok(Self {
            id: input.id.unwrap_or_else(Uuid::new_v4),
            name: name.to_owned(),
            kind: input.kind,
            base_url: normalize_base_url(&input.base_url)?,
            model,
        })
    }
}

/// HTTPS only, except plain HTTP to this device for local models (Ollama, LM Studio). No
/// credentials, query or fragment, so a key can never end up inside a URL.
pub fn normalize_base_url(input: &str) -> Result<String> {
    let invalid = |why: &str| Error::InvalidProvider(why.to_owned());
    let url = Url::parse(input.trim()).map_err(|_| invalid("the base URL is not a valid URL"))?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => {
            return Err(invalid(
                "the base URL must be https (http only for this device)",
            ));
        }
    }
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid(
            "the base URL must not contain credentials, a query or a fragment",
        ));
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

pub fn validate_key(key: &str) -> Result<()> {
    if key.is_empty() {
        return Err(Error::InvalidKey("the key is empty"));
    }
    if key.len() > 512 {
        return Err(Error::InvalidKey("the key is too long"));
    }
    if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(Error::InvalidKey(
            "the key contains spaces or control characters",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(name: &str, base: &str) -> ProviderInput {
        ProviderInput {
            id: None,
            name: name.into(),
            kind: ProviderKind::OpenAiCompatible,
            base_url: base.into(),
            model: Some("  gpt-x  ".into()),
        }
    }

    #[test]
    fn a_valid_provider_is_trimmed_and_normalized() {
        let config =
            ProviderConfig::from_input(input(" My provider ", "https://api.openai.com/v1/"))
                .unwrap();
        assert_eq!(config.name, "My provider");
        assert_eq!(config.base_url, "https://api.openai.com/v1");
        assert_eq!(config.model.as_deref(), Some("gpt-x"));
    }

    #[test]
    fn base_urls_must_be_https_or_this_device() {
        assert!(normalize_base_url("http://localhost:11434/v1").is_ok());
        assert!(normalize_base_url("http://127.0.0.1:1234/v1").is_ok());
        for bad in [
            "http://example.com/v1",
            "https://user:pw@example.com/v1",
            "https://example.com/v1?key=abc",
            "https://example.com/v1#frag",
            "file:///etc/passwd",
            "not a url",
        ] {
            assert!(normalize_base_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn names_and_models_are_bounded() {
        assert!(ProviderConfig::from_input(input("   ", "https://a.com")).is_err());
        assert!(ProviderConfig::from_input(input(&"x".repeat(31), "https://a.com")).is_err());
        let mut long_model = input("ok", "https://a.com");
        long_model.model = Some("m".repeat(101));
        assert!(ProviderConfig::from_input(long_model).is_err());
    }

    #[test]
    fn keys_must_be_one_clean_token() {
        assert!(validate_key("sk-ant-abc123").is_ok());
        for bad in ["", "has space", "line\nbreak", &"k".repeat(513)] {
            assert!(validate_key(bad).is_err());
        }
    }
}
