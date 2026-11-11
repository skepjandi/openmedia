//! Anthropic Messages API with forced tool use: the patch schema is the tool's input schema and the
//! model must call that tool, so the answer is structured by the API and still validated by us.

use reqwest::Client;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::{
    ProviderConfig,
    prompt::Prompt,
    provider::{
        ApiRequest, MAX_TOOL_CALLS, MSG_REFUSED, MSG_STRUCTURE, ModelReply, ToolCall,
        ToolDefinition, Turn, bounded_text, failure, model_of, object_args, send, status_error,
    },
};
use crate::error::Result;

const ANTHROPIC_VERSION: &str = "2023-06-01";
const TOOL_NAME: &str = "propose_patch";
const MAX_OUTPUT_TOKENS: u32 = 2048;

pub(super) fn build_request(
    base_url: &str,
    config: &ProviderConfig,
    key: &str,
    prompt: &Prompt,
    schema: &Value,
) -> Result<ApiRequest> {
    Ok(ApiRequest {
        url: format!("{base_url}/v1/messages"),
        headers: vec![
            ("x-api-key", Zeroizing::new(key.to_owned())),
            (
                "anthropic-version",
                Zeroizing::new(ANTHROPIC_VERSION.to_owned()),
            ),
        ],
        body: json!({
            "model": model_of(config)?,
            "max_tokens": MAX_OUTPUT_TOKENS,
            "temperature": 0,
            "system": prompt.system,
            "messages": [{ "role": "user", "content": prompt.user }],
            "tools": [{
                "name": TOOL_NAME,
                "description": "Propose the switch (option) and its hide rules for the user's request.",
                "input_schema": schema,
            }],
            "tool_choice": { "type": "tool", "name": TOOL_NAME },
        }),
    })
}

/// The tool call's input as JSON text, or a fixed error for a refusal or any other shape.
pub(super) fn parse_response(body: &Value) -> Result<String> {
    let stop = body.get("stop_reason").and_then(Value::as_str);
    if stop == Some("refusal") {
        return Err(failure(MSG_REFUSED));
    }
    let call = body
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|block| {
            block.get("type").and_then(Value::as_str) == Some("tool_use")
                && block.get("name").and_then(Value::as_str) == Some(TOOL_NAME)
        });
    match call
        .and_then(|block| block.get("input"))
        .filter(|input| input.is_object())
    {
        Some(input) if stop != Some("max_tokens") => {
            serde_json::to_string(input).map_err(|_| failure(MSG_STRUCTURE))
        }
        _ => Err(failure(MSG_STRUCTURE)),
    }
}

pub(super) async fn complete(
    client: &Client,
    base_url: &str,
    config: &ProviderConfig,
    key: &str,
    prompt: &Prompt,
    schema: &Value,
) -> Result<String> {
    let request = build_request(base_url, config, key, prompt, schema)?;
    let (status, body) = send(client, &request).await?;
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
        "max_tokens": MAX_OUTPUT_TOKENS,
        "temperature": 0,
        "system": system,
        "messages": messages(turns),
        "tools": tools
            .iter()
            .map(|tool| json!({
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.input_schema,
            }))
            .collect::<Vec<_>>(),
    });
    Ok(ApiRequest {
        url: format!("{base_url}/v1/messages"),
        headers: vec![
            ("x-api-key", Zeroizing::new(key.to_owned())),
            (
                "anthropic-version",
                Zeroizing::new(ANTHROPIC_VERSION.to_owned()),
            ),
        ],
        body,
    })
}

/// The conversation the way Anthropic wants it: the user's words, the model's own turn with the
/// tools it asked to run, and the answers to those tools as the user turn right after them.
fn messages(turns: &[Turn]) -> Vec<Value> {
    let mut messages: Vec<Value> = Vec::new();
    let mut answers: Vec<Value> = Vec::new();
    for turn in turns {
        match turn {
            Turn::User { text } => {
                add_answers(&mut messages, &mut answers);
                messages.push(json!({ "role": "user", "content": text }));
            }
            Turn::Assistant { text, tool_calls } => {
                add_answers(&mut messages, &mut answers);
                let mut content: Vec<Value> = Vec::new();
                if let Some(text) = text.as_ref().filter(|text| !text.trim().is_empty()) {
                    content.push(json!({ "type": "text", "text": text }));
                }
                for call in tool_calls {
                    content.push(json!({
                        "type": "tool_use",
                        "id": call.id,
                        "name": call.name,
                        "input": call.arguments,
                    }));
                }
                if !content.is_empty() {
                    messages.push(json!({ "role": "assistant", "content": content }));
                }
            }
            Turn::ToolResult(result) => {
                answers.push(json!({
                    "type": "tool_result",
                    "tool_use_id": result.call_id,
                    "content": bounded_text(&result.content),
                    "is_error": result.is_error,
                }));
            }
        }
    }
    add_answers(&mut messages, &mut answers);
    messages
}

/// Anthropic wants the answers to one round of tool calls in the user turn right after them, and
/// the tool answers first in that turn.
fn add_answers(messages: &mut Vec<Value>, answers: &mut Vec<Value>) {
    if answers.is_empty() {
        return;
    }
    let blocks = std::mem::take(answers);
    let is_user = messages
        .last()
        .and_then(|last| last.get("role"))
        .and_then(Value::as_str)
        == Some("user");
    if !is_user {
        messages.push(json!({ "role": "user", "content": blocks }));
        return;
    }
    let Some(last) = messages.last_mut() else {
        return;
    };
    let mut content: Vec<Value> = Vec::new();
    match last.get_mut("content") {
        Some(Value::Array(existing)) => content.append(existing),
        Some(Value::String(text)) => {
            let text = std::mem::take(text);
            content.push(json!({ "type": "text", "text": text }));
        }
        _ => {}
    }
    content.splice(0..0, blocks);
    last["content"] = Value::Array(content);
}

/// The model's answer: its own words, or the tools it wants to run.
pub(super) fn parse_tool_response(body: &Value) -> Result<ModelReply> {
    let stop = body.get("stop_reason").and_then(Value::as_str);
    if stop == Some("refusal") {
        return Err(failure(MSG_REFUSED));
    }
    if stop == Some("max_tokens") {
        return Err(failure(MSG_STRUCTURE));
    }
    let blocks = body
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| failure(MSG_STRUCTURE))?;
    let mut calls: Vec<ToolCall> = Vec::new();
    let mut text = String::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("tool_use") => {
                if calls.len() >= MAX_TOOL_CALLS {
                    return Err(failure(MSG_STRUCTURE));
                }
                let id = block.get("id").and_then(Value::as_str).unwrap_or_default();
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if id.is_empty() || name.is_empty() {
                    return Err(failure(MSG_STRUCTURE));
                }
                calls.push(ToolCall {
                    id: id.to_owned(),
                    name: name.to_owned(),
                    arguments: object_args(block.get("input"))?,
                });
            }
            Some("text") => {
                if let Some(part) = block.get("text").and_then(Value::as_str) {
                    text.push_str(part);
                }
            }
            _ => {}
        }
    }
    if !calls.is_empty() {
        return Ok(ModelReply::ToolCalls(calls));
    }
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
        patch::patch_schema,
        provider::{
            ToolResult, complete as complete_via_provider,
            complete_with_tools as complete_with_tools_via_provider,
            test_server::{config, prompt, serve},
        },
    };
    use crate::error::Error;

    const SUCCESS: &str = r#"{"id":"msg_01","type":"message","role":"assistant","model":"claude-x",
      "content":[{"type":"text","text":"Calling the tool."},
                 {"type":"tool_use","id":"toolu_01","name":"propose_patch",
                  "input":{"kind":"newOption","summary":"Hides the stories row.","optionId":null,
                           "label":"Hide stories","description":"The story circles.","group":"content",
                           "rules":[{"label":"Stories","selector":"div.stories-row"}]}}],
      "stop_reason":"tool_use","usage":{"input_tokens":10,"output_tokens":5}}"#;

    fn run(base: &str, key: &str) -> Result<String> {
        let config = config(ProviderKind::Anthropic, base, Some("claude-x"));
        tauri::async_runtime::block_on(complete_via_provider(
            &config,
            key,
            &prompt(),
            &patch_schema(),
        ))
    }

    #[test]
    fn the_request_forces_the_patch_tool_and_carries_both_messages() {
        let config = config(
            ProviderKind::Anthropic,
            "https://api.anthropic.com",
            Some("claude-x"),
        );
        let request = build_request(
            "https://api.anthropic.com",
            &config,
            "sk-ant-key",
            &prompt(),
            &patch_schema(),
        )
        .unwrap();
        assert_eq!(request.url, "https://api.anthropic.com/v1/messages");
        let header = |name: &str| {
            request
                .headers
                .iter()
                .find(|(n, _)| *n == name)
                .map(|(_, v)| v.as_str().to_owned())
        };
        assert_eq!(header("x-api-key").as_deref(), Some("sk-ant-key"));
        assert_eq!(header("anthropic-version").as_deref(), Some("2023-06-01"));
        assert!(!request.url.contains("sk-ant-key"));
        let body = &request.body;
        assert_eq!(body["model"], "claude-x");
        assert_eq!(body["system"], "SYSTEM TEXT");
        assert_eq!(
            body["messages"],
            json!([{ "role": "user", "content": "USER TEXT" }])
        );
        assert_eq!(
            body["tool_choice"],
            json!({ "type": "tool", "name": "propose_patch" })
        );
        assert_eq!(body["tools"][0]["name"], "propose_patch");
        assert_eq!(body["tools"][0]["input_schema"], patch_schema());
        assert!(!body.to_string().contains("sk-ant-key"));
    }

    #[test]
    fn a_tool_call_becomes_the_patch_json() {
        let answer = parse_response(&serde_json::from_str(SUCCESS).unwrap()).unwrap();
        let patch = crate::ai::patch::parse_patch(&answer, None).unwrap();
        assert_eq!(patch.summary(), "Hides the stories row.");
    }

    #[test]
    fn refusals_and_odd_shapes_are_fixed_errors() {
        let message = |body: Value| parse_response(&body).unwrap_err().to_string();
        assert!(message(json!({ "stop_reason": "refusal", "content": [] })).contains("declined"));
        for body in [
            json!({ "content": [{ "type": "text", "text": "I would rather not." }], "stop_reason": "end_turn" }),
            json!({ "content": [{ "type": "tool_use", "name": "other", "input": {} }] }),
            json!({ "content": [{ "type": "tool_use", "name": "propose_patch", "input": "str" }] }),
            json!({ "content": [{ "type": "tool_use", "name": "propose_patch", "input": {"kind":"newOption"} }], "stop_reason": "max_tokens" }),
            json!({ "content": "nope" }),
            json!(null),
        ] {
            assert!(message(body).contains("not in the expected form"));
        }
    }

    #[test]
    fn it_talks_to_a_server_end_to_end_and_maps_vendor_errors() {
        let server = serve(vec![(200, SUCCESS.to_owned())]);
        let answer = run(&server.base, "sk-ant-key").unwrap();
        assert!(answer.contains("Hide stories"));
        let seen = server.seen.lock().unwrap();
        assert!(seen[0].request_line.starts_with("POST /v1/messages "));
        assert!(
            seen[0]
                .headers
                .to_lowercase()
                .contains("x-api-key: sk-ant-key")
        );
        assert!(seen[0].body.contains("\"tool_choice\""));
        drop(seen);

        for (status, needle) in [
            (401, "rejected the key"),
            (403, "rejected the key"),
            (429, "rate limiting"),
            (500, "server error"),
            (529, "overloaded"),
            (400, "Check the model"),
        ] {
            let body = r#"{"type":"error","error":{"type":"x","message":"sk-ant-key leaked in provider text"}}"#;
            let server = serve(vec![(status, body.to_owned())]);
            let err = run(&server.base, "sk-ant-key").unwrap_err();
            let text = err.to_string();
            assert!(text.contains(needle), "{status}: {text}");
            assert!(!text.contains("leaked") && !text.contains("sk-ant-key"));
            assert!(matches!(err, Error::Connection(_)));
        }
    }

    #[test]
    fn a_non_json_success_body_is_an_invalid_structure_not_a_leak() {
        let server = serve(vec![(200, "<html>sk-ant-key</html>".to_owned())]);
        let text = run(&server.base, "sk-ant-key").unwrap_err().to_string();
        assert!(text.contains("not in the expected form") && !text.contains("html"));
    }

    const TOOL_CALL_ANSWER: &str = r#"{"id":"msg_02","type":"message","role":"assistant","model":"claude-x",
      "content":[{"type":"tool_use","id":"toolu_01","name":"search_marketplace",
                  "input":{"query":"hide reels"}}],
      "stop_reason":"tool_use","usage":{"input_tokens":10,"output_tokens":5}}"#;

    const FINAL_ANSWER: &str = r#"{"id":"msg_03","type":"message","role":"assistant","model":"claude-x",
      "content":[{"type":"text","text":"The marketplace has a recipe for that."}],
      "stop_reason":"end_turn","usage":{"input_tokens":20,"output_tokens":9}}"#;

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
            ProviderKind::Anthropic,
            "https://api.anthropic.com",
            Some("claude-x"),
        );
        let tools = [search_tool()];
        let turns = [
            Turn::User {
                text: "hide the reels".to_owned(),
            },
            Turn::Assistant {
                text: None,
                tool_calls: vec![ToolCall {
                    id: "toolu_01".to_owned(),
                    name: "search_marketplace".to_owned(),
                    arguments: json!({ "query": "hide reels" }),
                }],
            },
            Turn::ToolResult(ToolResult {
                call_id: "toolu_01".to_owned(),
                name: "search_marketplace".to_owned(),
                content: "two recipes".to_owned(),
                is_error: false,
            }),
        ];
        let request = build_tool_request(
            "https://api.anthropic.com",
            &config,
            "sk-ant-key",
            "SYSTEM",
            &tools,
            &turns,
        )
        .unwrap();
        assert_eq!(request.url, "https://api.anthropic.com/v1/messages");
        let body = &request.body;
        assert_eq!(body["model"], "claude-x");
        assert_eq!(body["system"], "SYSTEM");
        assert_eq!(body["tools"][0]["name"], "search_marketplace");
        assert_eq!(
            body["tools"][0]["input_schema"]["properties"]["query"]["type"],
            "string"
        );
        assert!(body.get("tool_choice").is_none());
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(
            messages[0],
            json!({ "role": "user", "content": "hide the reels" })
        );
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(
            messages[1]["content"][0],
            json!({
                "type": "tool_use",
                "id": "toolu_01",
                "name": "search_marketplace",
                "input": { "query": "hide reels" },
            })
        );
        assert_eq!(messages[2]["role"], "user");
        assert_eq!(messages[2]["content"][0]["type"], "tool_result");
        assert_eq!(messages[2]["content"][0]["tool_use_id"], "toolu_01");
        assert_eq!(messages[2]["content"][0]["content"], "two recipes");
        assert_eq!(messages[2]["content"][0]["is_error"], false);
        assert!(!body.to_string().contains("sk-ant-key"));
    }

    #[test]
    fn a_tool_call_becomes_a_typed_call() {
        let reply = parse_tool_response(&serde_json::from_str(TOOL_CALL_ANSWER).unwrap()).unwrap();
        let ModelReply::ToolCalls(calls) = reply else {
            panic!("expected tool calls");
        };
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "toolu_01");
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
            json!({ "content": [{ "type": "tool_use", "name": "search", "input": {} }] }),
            json!({ "content": [{ "type": "tool_use", "id": "toolu_01", "input": {} }] }),
            json!({ "content": [{ "type": "tool_use", "id": "toolu_01", "name": "search", "input": "text" }] }),
            json!({ "content": [{ "type": "tool_use", "id": "toolu_01", "name": "search" }] }),
            json!({ "content": [] }),
            json!({ "content": "nope" }),
            json!(null),
        ] {
            assert!(message(body).contains("not in the expected form"));
        }
        assert_eq!(
            parse_tool_response(&json!({
                "content": [{ "type": "text", "text": "I would rather not." }]
            }))
            .unwrap(),
            ModelReply::Text("I would rather not.".to_owned())
        );
        assert!(message(json!({ "stop_reason": "refusal", "content": [] })).contains("declined"));
        assert!(
            message(json!({ "stop_reason": "max_tokens", "content": [] }))
                .contains("not in the expected form")
        );
    }

    #[test]
    fn a_tool_call_and_its_answer_go_back_to_the_provider() {
        let server = serve(vec![
            (200, TOOL_CALL_ANSWER.to_owned()),
            (200, FINAL_ANSWER.to_owned()),
        ]);
        let config = config(ProviderKind::Anthropic, &server.base, Some("claude-x"));
        let tools = [search_tool()];
        let mut turns = vec![Turn::User {
            text: "hide the reels".to_owned(),
        }];
        let reply = tauri::async_runtime::block_on(complete_with_tools_via_provider(
            &config,
            "sk-ant-key",
            "SYSTEM",
            &tools,
            &turns,
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
            &config,
            "sk-ant-key",
            "SYSTEM",
            &tools,
            &turns,
        ))
        .unwrap();
        assert_eq!(
            answer,
            ModelReply::Text("The marketplace has a recipe for that.".to_owned())
        );
        let seen = server.seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(seen[0].body.contains("\"tools\""));
        assert!(seen[1].body.contains("tool_use"));
        assert!(seen[1].body.contains("tool_result"));
        assert!(seen[1].body.contains("toolu_01"));
        assert!(seen[1].body.contains("two recipes"));
    }
}
