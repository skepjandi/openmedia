//! OpenAI-compatible chat completions (OpenAI, Gemini's compatible endpoint, OpenRouter, Ollama, LM
//! Studio and the like). First asks for a strict `json_schema`; a server that rejects that gets one
//! more try in plain `json_object` mode with the schema spelled out in the system message.

use reqwest::Client;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::{
    ProviderConfig,
    prompt::Prompt,
    provider::{
        ApiRequest, MAX_TOOL_CALLS, MSG_REFUSED, MSG_STRUCTURE, ModelReply, ToolCall,
        ToolDefinition, Turn, bounded_text, failure, model_of, send, status_error, text_args,
    },
};
use crate::error::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Mode {
    JsonSchema,
    JsonObject,
}

pub(super) fn build_request(
    base_url: &str,
    config: &ProviderConfig,
    key: &str,
    prompt: &Prompt,
    schema: &Value,
    mode: Mode,
) -> Result<ApiRequest> {
    let (system, response_format) = match mode {
        Mode::JsonSchema => (
            prompt.system.clone(),
            json!({
                "type": "json_schema",
                "json_schema": { "name": "openmedia_patch", "strict": true, "schema": schema },
            }),
        ),
        Mode::JsonObject => (
            format!(
                "{}\n\nReply with a single JSON object and nothing else (no Markdown). It must follow this JSON Schema exactly:\n{}",
                prompt.system, schema
            ),
            json!({ "type": "json_object" }),
        ),
    };
    Ok(ApiRequest {
        url: format!("{base_url}/chat/completions"),
        headers: vec![("authorization", Zeroizing::new(format!("Bearer {key}")))],
        body: json!({
            "model": model_of(config)?,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": prompt.user },
            ],
            "response_format": response_format,
        }),
    })
}

/// The model's message as JSON text.
pub(super) fn parse_response(body: &Value) -> Result<String> {
    let choice = body
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or_else(|| failure(MSG_STRUCTURE))?;
    let message = choice
        .get("message")
        .ok_or_else(|| failure(MSG_STRUCTURE))?;
    let refusal = message
        .get("refusal")
        .and_then(Value::as_str)
        .is_some_and(|text| !text.is_empty());
    if refusal || choice.get("finish_reason").and_then(Value::as_str) == Some("content_filter") {
        return Err(failure(MSG_REFUSED));
    }
    if choice.get("finish_reason").and_then(Value::as_str) == Some("length") {
        return Err(failure(MSG_STRUCTURE));
    }
    let text = match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    };
    if text.trim().is_empty() {
        return Err(failure(MSG_STRUCTURE));
    }
    Ok(text)
}

/// Whether a failure means "this server does not take `json_schema`", worth one more try.
pub(super) fn rejects_response_format(status: u16) -> bool {
    matches!(status, 400 | 404 | 422 | 501)
}

pub(super) async fn complete(
    client: &Client,
    base_url: &str,
    config: &ProviderConfig,
    key: &str,
    prompt: &Prompt,
    schema: &Value,
) -> Result<String> {
    let strict = build_request(base_url, config, key, prompt, schema, Mode::JsonSchema)?;
    let (status, body) = send(client, &strict).await?;
    if (200..300).contains(&status) {
        return parse_response(&body);
    }
    if !rejects_response_format(status) {
        return Err(status_error(status));
    }
    let relaxed = build_request(base_url, config, key, prompt, schema, Mode::JsonObject)?;
    let (status, body) = send(client, &relaxed).await?;
    if !(200..300).contains(&status) {
        return Err(status_error(status));
    }
    parse_response(&body)
}

/// The request for the tools path: the tools the model may call, and the conversation so far.
pub(super) fn build_tool_request(
    base_url: &str,
    config: &ProviderConfig,
    key: &str,
    system: &str,
    tools: &[ToolDefinition],
    turns: &[Turn],
) -> Result<ApiRequest> {
    let body = json!({
        "model": model_of(config)?,
        "messages": messages(system, turns),
        "tools": tools
            .iter()
            .map(|tool| json!({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.input_schema,
                },
            }))
            .collect::<Vec<_>>(),
    });
    Ok(ApiRequest {
        url: format!("{base_url}/chat/completions"),
        headers: vec![("authorization", Zeroizing::new(format!("Bearer {key}")))],
        body,
    })
}

/// The conversation the way chat completions want it: the system's words, the user's, the model's
/// own turn with the tools it asked to run, and one turn per tool answer.
fn messages(system: &str, turns: &[Turn]) -> Vec<Value> {
    let mut messages: Vec<Value> = Vec::new();
    if !system.trim().is_empty() {
        messages.push(json!({ "role": "system", "content": system }));
    }
    for turn in turns {
        match turn {
            Turn::User { text } => {
                messages.push(json!({ "role": "user", "content": text }));
            }
            Turn::Assistant { text, tool_calls } => {
                let mut message = json!({
                    "role": "assistant",
                    "content": text.clone().filter(|text| !text.trim().is_empty()),
                });
                if !tool_calls.is_empty() {
                    let calls = tool_calls
                        .iter()
                        .map(|call| {
                            json!({
                                "id": call.id,
                                "type": "function",
                                "function": {
                                    "name": call.name,
                                    "arguments": serde_json::to_string(&call.arguments)
                                        .unwrap_or_else(|_| "{}".to_owned()),
                                },
                            })
                        })
                        .collect::<Vec<_>>();
                    message["tool_calls"] = Value::Array(calls);
                }
                messages.push(message);
            }
            Turn::ToolResult(result) => {
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": result.call_id,
                    "name": result.name,
                    "content": bounded_text(&result.content),
                }));
            }
        }
    }
    messages
}

/// The model's answer: its own words, or the tools it wants to run.
pub(super) fn parse_tool_response(body: &Value) -> Result<ModelReply> {
    let choice = body
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or_else(|| failure(MSG_STRUCTURE))?;
    let message = choice
        .get("message")
        .ok_or_else(|| failure(MSG_STRUCTURE))?;
    let refusal = message
        .get("refusal")
        .and_then(Value::as_str)
        .is_some_and(|text| !text.is_empty());
    if refusal || choice.get("finish_reason").and_then(Value::as_str) == Some("content_filter") {
        return Err(failure(MSG_REFUSED));
    }
    if choice.get("finish_reason").and_then(Value::as_str) == Some("length") {
        return Err(failure(MSG_STRUCTURE));
    }
    let mut calls: Vec<ToolCall> = Vec::new();
    if let Some(list) = message.get("tool_calls").and_then(Value::as_array) {
        for call in list {
            if calls.len() >= MAX_TOOL_CALLS {
                return Err(failure(MSG_STRUCTURE));
            }
            let id = call.get("id").and_then(Value::as_str).unwrap_or_default();
            let function = call.get("function");
            let name = function
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if id.is_empty() || name.is_empty() {
                return Err(failure(MSG_STRUCTURE));
            }
            let arguments = text_args(function.and_then(|function| function.get("arguments")))?;
            calls.push(ToolCall {
                id: id.to_owned(),
                name: name.to_owned(),
                arguments,
            });
        }
    }
    if !calls.is_empty() {
        return Ok(ModelReply::ToolCalls(calls));
    }
    let text = match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    };
    if text.trim().is_empty() {
        return Err(failure(MSG_STRUCTURE));
    }
    Ok(ModelReply::Text(text))
}

/// Asks the model to answer with words or with tool calls. The tools are not run here.
pub(super) async fn complete_with_tools(
    client: &Client,
    base_url: &str,
    config: &ProviderConfig,
    key: &str,
    system: &str,
    tools: &[ToolDefinition],
    turns: &[Turn],
) -> Result<ModelReply> {
    let request = build_tool_request(base_url, config, key, system, tools, turns)?;
    let (status, body) = send(client, &request).await?;
    if !(200..300).contains(&status) {
        return Err(status_error(status));
    }
    parse_tool_response(&body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{
        ProviderKind,
        patch::{parse_patch, patch_schema},
        provider::{
            ToolResult, complete as complete_via_provider,
            complete_with_tools as complete_with_tools_via_provider,
            test_server::{config, prompt, serve},
        },
    };

    const PATCH: &str = r#"{\"kind\":\"newOption\",\"summary\":\"Hides the stories row.\",\"optionId\":null,\"label\":\"Hide stories\",\"description\":\"The story circles.\",\"group\":\"content\",\"rules\":[{\"label\":\"Stories\",\"selector\":\"div.stories-row\"}]}"#;

    fn success() -> String {
        format!(
            r#"{{"id":"chatcmpl-1","object":"chat.completion","choices":[{{"index":0,"message":{{"role":"assistant","content":"{PATCH}","refusal":null}},"finish_reason":"stop"}}],"usage":{{"prompt_tokens":10}}}}"#
        )
    }

    fn run(base: &str, key: &str) -> Result<String> {
        let config = config(
            ProviderKind::OpenAiCompatible,
            &format!("{base}/v1"),
            Some("gpt-x"),
        );
        tauri::async_runtime::block_on(complete_via_provider(
            &config,
            key,
            &prompt(),
            &patch_schema(),
        ))
    }

    #[test]
    fn the_strict_request_has_the_schema_and_a_bearer_token() {
        let config = config(
            ProviderKind::OpenAiCompatible,
            "https://api.openai.com/v1",
            Some("gpt-x"),
        );
        let request = build_request(
            "https://api.openai.com/v1",
            &config,
            "sk-key",
            &prompt(),
            &patch_schema(),
            Mode::JsonSchema,
        )
        .unwrap();
        assert_eq!(request.url, "https://api.openai.com/v1/chat/completions");
        assert_eq!(request.headers.len(), 1);
        assert_eq!(request.headers[0].0, "authorization");
        assert_eq!(request.headers[0].1.as_str(), "Bearer sk-key");
        let body = &request.body;
        assert_eq!(body["model"], "gpt-x");
        assert_eq!(
            body["messages"][0],
            json!({ "role": "system", "content": "SYSTEM TEXT" })
        );
        assert_eq!(
            body["messages"][1],
            json!({ "role": "user", "content": "USER TEXT" })
        );
        assert_eq!(body["response_format"]["type"], "json_schema");
        assert_eq!(body["response_format"]["json_schema"]["strict"], true);
        assert_eq!(
            body["response_format"]["json_schema"]["schema"],
            patch_schema()
        );
        assert!(!body.to_string().contains("sk-key"));
    }

    #[test]
    fn the_fallback_request_spells_the_schema_out_in_the_system_message() {
        let config = config(
            ProviderKind::OpenAiCompatible,
            "http://localhost:11434/v1",
            Some("llama"),
        );
        let request = build_request(
            "http://localhost:11434/v1",
            &config,
            "k",
            &prompt(),
            &patch_schema(),
            Mode::JsonObject,
        )
        .unwrap();
        assert_eq!(
            request.body["response_format"],
            json!({ "type": "json_object" })
        );
        let system = request.body["messages"][0]["content"].as_str().unwrap();
        assert!(
            system.starts_with("SYSTEM TEXT") && system.contains("\"additionalProperties\":false")
        );
    }

    #[test]
    fn a_message_becomes_the_patch_json() {
        let body: Value = serde_json::from_str(&success()).unwrap();
        let text = parse_response(&body).unwrap();
        assert_eq!(
            parse_patch(&text, None).unwrap().summary(),
            "Hides the stories row."
        );
        let parts = json!({ "choices": [{ "message": { "content": [{ "type": "text", "text": "{\"a\":" }, { "type": "text", "text": "1}" }] }, "finish_reason": "stop" }] });
        assert_eq!(parse_response(&parts).unwrap(), "{\"a\":1}");
    }

    #[test]
    fn refusals_truncation_and_odd_shapes_are_fixed_errors() {
        let message = |body: Value| parse_response(&body).unwrap_err().to_string();
        let refusal = json!({ "choices": [{ "message": { "content": null, "refusal": "I can't help with that." }, "finish_reason": "stop" }] });
        let text = message(refusal);
        assert!(text.contains("declined") && !text.contains("can't help"));
        assert!(message(json!({ "choices": [{ "message": { "content": "" }, "finish_reason": "content_filter" }] })).contains("declined"));
        for body in [
            json!({ "choices": [{ "message": { "content": "{\"kind\":" }, "finish_reason": "length" }] }),
            json!({ "choices": [] }),
            json!({ "choices": [{ "message": { "content": "  " }, "finish_reason": "stop" }] }),
            json!({ "choices": [{ "finish_reason": "stop" }] }),
            json!({ "error": { "message": "x" } }),
            json!(null),
        ] {
            assert!(message(body).contains("not in the expected form"));
        }
    }

    #[test]
    fn it_works_end_to_end_and_never_leaks_a_provider_body() {
        let server = serve(vec![(200, success())]);
        let answer = run(&server.base, "sk-key").unwrap();
        assert!(parse_patch(&answer, None).is_ok());
        let seen = server.seen.lock().unwrap();
        assert!(
            seen[0]
                .request_line
                .starts_with("POST /v1/chat/completions ")
        );
        assert!(
            seen[0]
                .headers
                .to_lowercase()
                .contains("authorization: bearer sk-key")
        );
        assert!(seen[0].body.contains("\"json_schema\""));
        drop(seen);

        for (status, needle) in [
            (401, "rejected the key"),
            (403, "rejected the key"),
            (429, "rate limiting"),
            (500, "server error"),
            (502, "server error"),
            (503, "server error"),
        ] {
            let server = serve(vec![(
                status,
                r#"{"error":{"message":"bad key sk-key supplied"}}"#.to_owned(),
            )]);
            let text = run(&server.base, "sk-key").unwrap_err().to_string();
            assert!(text.contains(needle), "{status}: {text}");
            assert!(!text.contains("sk-key") && !text.contains("supplied"));
            assert_eq!(
                server.seen.lock().unwrap().len(),
                1,
                "no fallback for {status}"
            );
        }
    }

    #[test]
    fn a_server_that_rejects_json_schema_gets_one_json_object_retry() {
        let server = serve(vec![
            (
                400,
                r#"{"error":{"message":"response_format json_schema is not supported"}}"#
                    .to_owned(),
            ),
            (200, success()),
        ]);
        let answer = run(&server.base, "sk-key").unwrap();
        assert!(parse_patch(&answer, None).is_ok());
        let seen = server.seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(seen[0].body.contains("\"json_schema\""));
        assert!(seen[1].body.contains("\"json_object\"") && !seen[1].body.contains("\"strict\""));
    }

    #[test]
    fn the_fallback_is_tried_once_and_its_failure_is_reported() {
        let server = serve(vec![(422, "{}".to_owned()), (429, "{}".to_owned())]);
        let text = run(&server.base, "sk-key").unwrap_err().to_string();
        assert!(text.contains("rate limiting"));
        assert_eq!(server.seen.lock().unwrap().len(), 2);

        let server = serve(vec![(400, "{}".to_owned()), (400, "{}".to_owned())]);
        let text = run(&server.base, "sk-key").unwrap_err().to_string();
        assert!(text.contains("Check the model"));
    }

    #[test]
    fn malformed_content_from_a_200_is_reported_by_the_patch_validator_not_here() {
        let body = r#"{"choices":[{"message":{"content":"Sure! Here you go: {oops"},"finish_reason":"stop"}]}"#;
        let server = serve(vec![(200, body.to_owned())]);
        let answer = run(&server.base, "sk-key").unwrap();
        assert!(parse_patch(&answer, None).is_err());
    }

    const TOOL_CALL_ANSWER: &str = r#"{"id":"chatcmpl-2","object":"chat.completion","choices":[{"index":0,
      "message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_01","type":"function",
      "function":{"name":"search_marketplace","arguments":"{\"query\":\"hide reels\"}"}}]},
      "finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10}}"#;

    const FINAL_ANSWER: &str = r#"{"id":"chatcmpl-3","object":"chat.completion","choices":[{"index":0,
      "message":{"role":"assistant","content":"The marketplace has a recipe for that."},
      "finish_reason":"stop"}],"usage":{"prompt_tokens":20}}"#;

    fn search_tool() -> ToolDefinition {
        ToolDefinition {
            name: "search_marketplace".to_owned(),
            description: "Search the marketplace.".to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": { "query": { "type": "string" } },
            }),
        }
    }

    #[test]
    fn the_tool_request_carries_the_tools_the_calls_and_the_answers() {
        let config = config(
            ProviderKind::OpenAiCompatible,
            "https://api.openai.com/v1",
            Some("gpt-x"),
        );
        let tools = [search_tool()];
        let turns = [
            Turn::User {
                text: "hide the reels".to_owned(),
            },
            Turn::Assistant {
                text: None,
                tool_calls: vec![ToolCall {
                    id: "call_01".to_owned(),
                    name: "search_marketplace".to_owned(),
                    arguments: json!({ "query": "hide reels" }),
                }],
            },
            Turn::ToolResult(ToolResult {
                call_id: "call_01".to_owned(),
                name: "search_marketplace".to_owned(),
                content: "two recipes".to_owned(),
                is_error: false,
            }),
        ];
        let request = build_tool_request(
            "https://api.openai.com/v1",
            &config,
            "sk-key",
            "SYSTEM",
            &tools,
            &turns,
        )
        .unwrap();
        assert_eq!(request.url, "https://api.openai.com/v1/chat/completions");
        let body = &request.body;
        assert_eq!(body["model"], "gpt-x");
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["function"]["name"], "search_marketplace");
        assert_eq!(
            body["tools"][0]["function"]["parameters"]["properties"]["query"]["type"],
            "string"
        );
        assert!(body.get("response_format").is_none());
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 4);
        assert_eq!(
            messages[0],
            json!({ "role": "system", "content": "SYSTEM" })
        );
        assert_eq!(
            messages[1],
            json!({ "role": "user", "content": "hide the reels" })
        );
        assert_eq!(messages[2]["role"], "assistant");
        assert_eq!(messages[2]["content"], Value::Null);
        assert_eq!(messages[2]["tool_calls"][0]["id"], "call_01");
        assert_eq!(messages[2]["tool_calls"][0]["type"], "function");
        assert_eq!(
            messages[2]["tool_calls"][0]["function"]["name"],
            "search_marketplace"
        );
        assert_eq!(
            messages[2]["tool_calls"][0]["function"]["arguments"],
            "{\"query\":\"hide reels\"}"
        );
        assert_eq!(messages[3]["role"], "tool");
        assert_eq!(messages[3]["tool_call_id"], "call_01");
        assert_eq!(messages[3]["content"], "two recipes");
        assert!(!body.to_string().contains("sk-key"));
    }

    #[test]
    fn a_tool_call_becomes_a_typed_call() {
        let reply = parse_tool_response(&serde_json::from_str(TOOL_CALL_ANSWER).unwrap()).unwrap();
        let ModelReply::ToolCalls(calls) = reply else {
            panic!("expected tool calls");
        };
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_01");
        assert_eq!(calls[0].name, "search_marketplace");
        assert_eq!(calls[0].arguments, json!({ "query": "hide reels" }));
        let words = parse_tool_response(&serde_json::from_str(FINAL_ANSWER).unwrap()).unwrap();
        assert_eq!(
            words,
            ModelReply::Text("The marketplace has a recipe for that.".to_owned())
        );
    }

    #[test]
    fn malformed_tool_calls_are_fixed_errors() {
        let message = |body: Value| parse_tool_response(&body).unwrap_err().to_string();
        for body in [
            json!({ "choices": [{ "message": { "tool_calls": [{ "type": "function", "function": { "name": "search", "arguments": "{}" } }] } }] }),
            json!({ "choices": [{ "message": { "tool_calls": [{ "id": "call_01", "function": { "arguments": "{}" } }] } }] }),
            json!({ "choices": [{ "message": { "tool_calls": [{ "id": "call_01", "function": { "name": "search", "arguments": "not json" } }] } }] }),
            json!({ "choices": [{ "message": { "tool_calls": [{ "id": "call_01", "function": { "name": "search", "arguments": "[1,2]" } }] } }] }),
            json!({ "choices": [{ "message": { "tool_calls": [{ "id": "call_01", "function": { "name": "search" } }] } }] }),
            json!({ "choices": [{ "message": { "content": null, "tool_calls": [] }, "finish_reason": "tool_calls" }] }),
            json!({ "choices": [] }),
            json!(null),
        ] {
            assert!(message(body).contains("not in the expected form"));
        }
        assert!(
            message(json!({ "choices": [{ "message": { "content": null, "refusal": "no" } }] }))
                .contains("declined")
        );
    }

    #[test]
    fn a_tool_call_and_its_answer_go_back_to_the_provider() {
        let server = serve(vec![
            (200, TOOL_CALL_ANSWER.to_owned()),
            (200, FINAL_ANSWER.to_owned()),
        ]);
        let config = config(
            ProviderKind::OpenAiCompatible,
            &format!("{}/v1", server.base),
            Some("gpt-x"),
        );
        let tools = [search_tool()];
        let mut turns = vec![Turn::User {
            text: "hide the reels".to_owned(),
        }];
        let reply = tauri::async_runtime::block_on(complete_with_tools_via_provider(
            &config, "sk-key", "SYSTEM", &tools, &turns,
        ))
        .unwrap();
        let ModelReply::ToolCalls(calls) = &reply else {
            panic!("expected tool calls");
        };
        turns.push(reply.assistant_turn());
        turns.push(Turn::ToolResult(ToolResult {
            call_id: calls[0].id.clone(),
            name: calls[0].name.clone(),
            content: "two recipes".to_owned(),
            is_error: false,
        }));
        let answer = tauri::async_runtime::block_on(complete_with_tools_via_provider(
            &config, "sk-key", "SYSTEM", &tools, &turns,
        ))
        .unwrap();
        assert_eq!(
            answer,
            ModelReply::Text("The marketplace has a recipe for that.".to_owned())
        );
        let seen = server.seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(seen[0].body.contains("\"tools\""));
        assert!(seen[1].body.contains("tool_calls"));
        assert!(seen[1].body.contains("\"role\":\"tool\""));
        assert!(seen[1].body.contains("call_01"));
        assert!(seen[1].body.contains("two recipes"));
    }
}
