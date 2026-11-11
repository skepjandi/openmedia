//! Calls the user's chosen provider from Rust. The key never leaves this module except inside the
//! request headers, is held in zeroizing buffers, and no error text contains a response body, a
//! header or the key.

use std::{borrow::Cow, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::Zeroizing;

use super::{
    ProviderConfig, ProviderKind, anthropic, connection::describe_status, normalize_base_url,
    openai, prompt::Prompt, validate_key,
};
use crate::error::{Error, Result};

const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
/// A tool answer is cut to this many characters before it goes back to the provider.
const MAX_TOOL_RESULT_CHARS: usize = 8 * 1024;
/// The most tool calls one answer may ask for.
pub(super) const MAX_TOOL_CALLS: usize = 32;
/// Providers take tool names of letters, digits, `_` and `-` only.
const MAX_TOOL_NAME_CHARS: usize = 64;

pub(super) const MSG_NETWORK: &str = "Could not reach the provider.";
pub(super) const MSG_SECURE: &str = "Could not start a secure connection.";
pub(super) const MSG_REFUSED: &str = "The model declined to answer.";
pub(super) const MSG_STRUCTURE: &str = "The model's answer was not in the expected form.";
pub(super) const MSG_UNREADABLE: &str = "The provider's answer was not understood.";
pub(super) const MSG_NO_MODEL: &str = "Choose a model for this provider in Settings first.";
pub(super) const MSG_BAD_REQUEST: &str = "The provider rejected the request. Check the model name.";
pub(super) const MSG_OVERLOADED: &str = "The provider is overloaded. Try again shortly.";
pub(super) const MSG_BAD_TOOL: &str = "The tool definition is not valid.";

/// A request as plain data so its shape can be checked without a network. `Debug` hides every
/// header value, because one of them is the key.
pub(super) struct ApiRequest {
    pub url: String,
    pub headers: Vec<(&'static str, Zeroizing<String>)>,
    pub body: Value,
}

impl std::fmt::Debug for ApiRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let names: Vec<&str> = self.headers.iter().map(|(name, _)| *name).collect();
        f.debug_struct("ApiRequest")
            .field("url", &self.url)
            .field("headers", &names)
            .finish_non_exhaustive()
    }
}

pub(super) fn failure(message: &str) -> Error {
    Error::Connection(message.to_owned())
}

/// A tool the model may ask to run. The schema is the provider's own JSON-schema dialect; the
/// caller of the tool is the one that checks what the model sends.
#[allow(dead_code, reason = "the marketplace agent caller uses this API")]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// A tool the model asked to run. The arguments are what the model sent and are not trusted: the
/// caller of the tool checks them against the tool's schema.
#[allow(dead_code, reason = "the marketplace agent caller uses this API")]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

/// What a tool answered. The text is cut to a fixed length before it goes back to the provider.
#[allow(dead_code, reason = "the marketplace agent caller uses this API")]
#[derive(Debug, Clone, PartialEq)]
pub struct ToolResult {
    pub call_id: String,
    pub name: String,
    pub content: String,
    pub is_error: bool,
}

/// One turn of the conversation with the model.
#[allow(dead_code, reason = "the marketplace agent caller uses this API")]
#[derive(Debug, Clone, PartialEq)]
pub enum Turn {
    /// What the user said.
    User { text: String },
    /// What the model said, and the tools it asked to run.
    Assistant {
        text: Option<String>,
        tool_calls: Vec<ToolCall>,
    },
    /// The answer to one tool call.
    ToolResult(ToolResult),
}

/// What the model answered: words, or the tools it wants to run.
#[allow(dead_code, reason = "the marketplace agent caller uses this API")]
#[derive(Debug, Clone, PartialEq)]
pub enum ModelReply {
    Text(String),
    ToolCalls(Vec<ToolCall>),
}

impl ModelReply {
    /// The turn that goes back into the conversation before the tool answers.
    #[allow(dead_code, reason = "the marketplace agent caller uses this API")]
    pub fn assistant_turn(&self) -> Turn {
        match self {
            ModelReply::Text(text) => Turn::Assistant {
                text: Some(text.clone()),
                tool_calls: Vec::new(),
            },
            ModelReply::ToolCalls(calls) => Turn::Assistant {
                text: None,
                tool_calls: calls.clone(),
            },
        }
    }
}

/// What the user is told for an HTTP status. Never includes the response body.
pub(super) fn status_error(status: u16) -> Error {
    Error::Connection(match status {
        400 | 413 | 422 => MSG_BAD_REQUEST.to_owned(),
        529 => MSG_OVERLOADED.to_owned(),
        other => describe_status(other),
    })
}

pub(super) fn model_of(config: &ProviderConfig) -> Result<&str> {
    config
        .model
        .as_deref()
        .filter(|model| !model.is_empty())
        .ok_or_else(|| failure(MSG_NO_MODEL))
}

/// Asks the provider for a patch and returns the JSON text of the model's answer. The caller
/// validates it with [`super::patch::parse_patch`]; nothing here trusts it.
pub async fn complete(
    config: &ProviderConfig,
    key: &str,
    prompt: &Prompt,
    schema: &Value,
) -> Result<String> {
    if key.is_empty() {
        return Err(Error::NoKey);
    }
    validate_key(key)?;
    let base = normalize_base_url(&config.base_url)?;
    let client = client()?;
    match config.kind {
        ProviderKind::Anthropic => {
            anthropic::complete(&client, &base, config, key, prompt, schema).await
        }
        ProviderKind::OpenAiCompatible => {
            openai::complete(&client, &base, config, key, prompt, schema).await
        }
    }
}

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        // A redirect could carry the key to another host.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| failure(MSG_SECURE))
}

/// Asks the provider to answer with words or with tool calls. The tools are not run here: the
/// caller checks the arguments, runs the tools itself and calls this again with the answers as
/// `Turn::ToolResult` turns, so the model sees what the tools said.
#[allow(dead_code, reason = "the marketplace agent caller uses this API")]
pub async fn complete_with_tools(
    config: &ProviderConfig,
    key: &str,
    system: &str,
    tools: &[ToolDefinition],
    turns: &[Turn],
) -> Result<ModelReply> {
    if key.is_empty() {
        return Err(Error::NoKey);
    }
    validate_key(key)?;
    let base = normalize_base_url(&config.base_url)?;
    check_tools(tools)?;
    let client = client()?;
    match config.kind {
        ProviderKind::Anthropic => {
            anthropic::complete_with_tools(&client, &base, config, key, system, tools, turns).await
        }
        ProviderKind::OpenAiCompatible => {
            openai::complete_with_tools(&client, &base, config, key, system, tools, turns).await
        }
    }
}

/// The tools must be ones a provider accepts: a plain name, used once, and an object schema.
fn check_tools(tools: &[ToolDefinition]) -> Result<()> {
    for (index, tool) in tools.iter().enumerate() {
        let name = tool.name.as_str();
        if name.is_empty()
            || name.chars().count() > MAX_TOOL_NAME_CHARS
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(failure(MSG_BAD_TOOL));
        }
        if !tool.input_schema.is_object() {
            return Err(failure(MSG_BAD_TOOL));
        }
        if tools[..index].iter().any(|other| other.name == tool.name) {
            return Err(failure(MSG_BAD_TOOL));
        }
    }
    Ok(())
}

/// Tool arguments the provider sent as an object.
pub(super) fn object_args(value: Option<&Value>) -> Result<Value> {
    value
        .filter(|value| value.is_object())
        .cloned()
        .ok_or_else(|| failure(MSG_STRUCTURE))
}

/// Tool arguments the provider sent as JSON text. Empty text means "no arguments"; anything that
/// is not a JSON object is an answer we cannot use.
pub(super) fn text_args(value: Option<&Value>) -> Result<Value> {
    let text = value
        .and_then(Value::as_str)
        .ok_or_else(|| failure(MSG_STRUCTURE))?;
    if text.trim().is_empty() {
        return Ok(Value::Object(serde_json::Map::new()));
    }
    let parsed: Value = serde_json::from_str(text).map_err(|_| failure(MSG_STRUCTURE))?;
    if !parsed.is_object() {
        return Err(failure(MSG_STRUCTURE));
    }
    Ok(parsed)
}

/// Tool answers are cut to a fixed length so one long answer cannot grow the request without end.
pub(super) fn bounded_text(text: &str) -> Cow<'_, str> {
    if text.chars().count() <= MAX_TOOL_RESULT_CHARS {
        return Cow::Borrowed(text);
    }
    Cow::Owned(text.chars().take(MAX_TOOL_RESULT_CHARS).collect())
}

/// Sends the request and returns the status with the body as JSON (`Null` when it is not JSON).
/// The body is read up to a cap and is never turned into an error message.
pub(super) async fn send(client: &reqwest::Client, request: &ApiRequest) -> Result<(u16, Value)> {
    let mut builder = client.post(&request.url).json(&request.body);
    for (name, value) in &request.headers {
        builder = builder.header(*name, value.as_str());
    }
    let mut response = builder.send().await.map_err(|_| failure(MSG_NETWORK))?;
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| failure(MSG_NETWORK))? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_BODY_BYTES {
            return Err(failure(MSG_UNREADABLE));
        }
    }
    Ok((
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    ))
}

/// A one-thread HTTP server on loopback for adapter tests: answers each request with the next
/// canned response and records what it was sent.
#[cfg(test)]
pub(super) mod test_server {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{Arc, Mutex},
        thread,
    };

    use super::{Prompt, ProviderConfig, ProviderKind};

    pub fn config(kind: ProviderKind, base: &str, model: Option<&str>) -> ProviderConfig {
        ProviderConfig {
            id: uuid::Uuid::nil(),
            name: "test".into(),
            kind,
            base_url: base.into(),
            model: model.map(str::to_owned),
        }
    }

    pub fn prompt() -> Prompt {
        Prompt {
            system: "SYSTEM TEXT".into(),
            user: "USER TEXT".into(),
            version: 1,
        }
    }

    #[derive(Debug, Clone)]
    pub struct Seen {
        pub request_line: String,
        pub headers: String,
        pub body: String,
    }

    pub struct Server {
        pub base: String,
        pub seen: Arc<Mutex<Vec<Seen>>>,
    }

    pub fn serve(responses: Vec<(u16, String)>) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        thread::spawn(move || {
            for (status, body) in responses {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut raw = Vec::new();
                let mut buf = [0_u8; 4096];
                let (head_end, length) = loop {
                    let n = stream.read(&mut buf).unwrap_or(0);
                    raw.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&raw).into_owned();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text[..end]
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        break (end + 4, length);
                    }
                    if n == 0 {
                        return;
                    }
                };
                while raw.len() < head_end + length {
                    let n = stream.read(&mut buf).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    raw.extend_from_slice(&buf[..n]);
                }
                let text = String::from_utf8_lossy(&raw).into_owned();
                let (head, body_text) = text.split_at(head_end.min(text.len()));
                let mut lines = head.lines();
                log.lock().unwrap().push(Seen {
                    request_line: lines.next().unwrap_or("").to_owned(),
                    headers: lines.collect::<Vec<_>>().join("\n"),
                    body: body_text.to_owned(),
                });
                let reply = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(reply.as_bytes());
            }
        });
        Server { base, seen }
    }
}

#[cfg(test)]
mod tests {
    use super::test_server::{config, prompt};
    use super::*;
    use crate::ai::patch::patch_schema;
    use serde_json::json;

    fn run(config: &ProviderConfig, key: &str) -> Result<String> {
        tauri::async_runtime::block_on(complete(config, key, &prompt(), &patch_schema()))
    }

    #[test]
    fn missing_and_malformed_keys_and_models_fail_before_any_request() {
        let ok = config(
            ProviderKind::Anthropic,
            "https://api.anthropic.com",
            Some("m"),
        );
        assert!(matches!(run(&ok, ""), Err(Error::NoKey)));
        assert!(matches!(run(&ok, "has space"), Err(Error::InvalidKey(_))));
        let no_model = config(ProviderKind::Anthropic, "https://api.anthropic.com", None);
        let err = run(&no_model, "sk-test").unwrap_err().to_string();
        assert_eq!(err, MSG_NO_MODEL);
        let plain_http = config(ProviderKind::Anthropic, "http://example.com", Some("m"));
        assert!(run(&plain_http, "sk-test").is_err());
    }

    #[test]
    fn status_errors_are_fixed_texts() {
        for (status, needle) in [
            (401, "rejected the key"),
            (403, "rejected the key"),
            (429, "rate limiting"),
            (500, "server error"),
            (503, "server error"),
            (529, "overloaded"),
            (400, "Check the model"),
            (404, "base URL"),
        ] {
            let text = status_error(status).to_string();
            assert!(text.contains(needle), "{status}: {text}");
        }
    }

    #[test]
    fn debug_output_hides_the_key() {
        let request = ApiRequest {
            url: "https://x.test".into(),
            headers: vec![("x-api-key", Zeroizing::new("sk-secret-value".into()))],
            body: json!({}),
        };
        let shown = format!("{request:?}");
        assert!(!shown.contains("sk-secret-value") && shown.contains("x-api-key"));
    }

    #[test]
    fn an_unreachable_provider_is_a_fixed_network_error() {
        // Port 9 on loopback refuses connections.
        let unreachable = config(
            ProviderKind::OpenAiCompatible,
            "http://127.0.0.1:9/v1",
            Some("m"),
        );
        let err = run(&unreachable, "sk-test-key").unwrap_err().to_string();
        assert_eq!(err, MSG_NETWORK);
        assert!(!err.contains("sk-test-key"));
    }

    fn tool(name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.to_owned(),
            description: "Search the marketplace.".to_owned(),
            input_schema: json!({ "type": "object", "properties": {} }),
        }
    }

    #[test]
    fn tool_definitions_must_be_ones_a_provider_accepts() {
        let good = tool("search_marketplace");
        assert!(check_tools(&[good.clone()]).is_ok());
        for bad in [
            ToolDefinition {
                name: String::new(),
                ..good.clone()
            },
            ToolDefinition {
                name: "two words".to_owned(),
                ..good.clone()
            },
            ToolDefinition {
                name: "x".repeat(MAX_TOOL_NAME_CHARS + 1),
                ..good.clone()
            },
            ToolDefinition {
                input_schema: json!("not a schema"),
                ..good.clone()
            },
        ] {
            let text = check_tools(&[bad]).unwrap_err().to_string();
            assert_eq!(text, MSG_BAD_TOOL);
        }
        let twice = check_tools(&[good.clone(), good]).unwrap_err().to_string();
        assert_eq!(twice, MSG_BAD_TOOL);
    }

    #[test]
    fn the_tool_path_wants_a_key_a_model_and_valid_tools() {
        let ok = config(
            ProviderKind::Anthropic,
            "https://api.anthropic.com",
            Some("m"),
        );
        let tools = [tool("search_marketplace")];
        let call = |config: &ProviderConfig, key: &str, tools: &[ToolDefinition]| {
            tauri::async_runtime::block_on(complete_with_tools(config, key, "SYSTEM", tools, &[]))
        };
        assert!(matches!(call(&ok, "", &tools), Err(Error::NoKey)));
        assert!(matches!(
            call(&ok, "has space", &tools),
            Err(Error::InvalidKey(_))
        ));
        let no_model = config(ProviderKind::Anthropic, "https://api.anthropic.com", None);
        assert_eq!(
            call(&no_model, "sk-test", &tools).unwrap_err().to_string(),
            MSG_NO_MODEL
        );
        let bad_tool = [ToolDefinition {
            name: "not a name".to_owned(),
            ..tool("search_marketplace")
        }];
        assert_eq!(
            call(&ok, "sk-test", &bad_tool).unwrap_err().to_string(),
            MSG_BAD_TOOL
        );
    }

    #[test]
    fn tool_answers_are_cut_to_a_fixed_length() {
        let short = "a short answer";
        assert_eq!(bounded_text(short), short);
        let long = "x".repeat(MAX_TOOL_RESULT_CHARS + 500);
        let cut = bounded_text(&long);
        assert_eq!(cut.chars().count(), MAX_TOOL_RESULT_CHARS);
    }
}
