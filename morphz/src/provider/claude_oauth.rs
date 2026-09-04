//! Claude subscription OAuth wire compatibility.
//!
//! Anthropic's subscription endpoint applies a Claude Code request profile in
//! addition to bearer-token authentication. Keep that volatile compatibility
//! surface isolated from the generic Anthropic Messages adapter so API-key and
//! third-party compatible providers retain their ordinary wire contract.

use super::auth::CLAUDE_CLI_VERSION;
use crate::llm::ToolDefinition;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};

const CLAUDE_CLI_IDENTITY: &str = "You are Claude Code, Anthropic's official CLI for Claude.";
const CCH_SEED: u64 = 0x4D65_9218_E32A_3268;

#[derive(Debug, Default)]
pub(crate) struct ClaudeOAuthToolAliases {
    forward: BTreeMap<String, String>,
    reverse: HashMap<String, String>,
}

impl ClaudeOAuthToolAliases {
    pub(crate) fn for_tools(tools: &[ToolDefinition], device_id: &str) -> Self {
        let server = hex_prefix(
            &Sha256::digest(
                [
                    b"morphz-claude-mcp-server-v1\0".as_slice(),
                    device_id.as_bytes(),
                ]
                .concat(),
            ),
            12,
        );
        let mut aliases = Self::default();
        for tool in tools {
            if is_mcp_tool_name(&tool.name) {
                continue;
            }
            let digest = Sha256::digest(
                [
                    b"morphz-claude-mcp-tool-v1\0".as_slice(),
                    device_id.as_bytes(),
                    b"\0",
                    tool.name.as_bytes(),
                ]
                .concat(),
            );
            let tool_id = hex_prefix(&digest, 8);
            let prefix = format!("mcp__{server}__{tool_id}_");
            let suffix = semantic_tool_suffix(&tool.name, 64usize.saturating_sub(prefix.len()));
            let alias = format!("{prefix}{suffix}");
            aliases.forward.insert(tool.name.clone(), alias.clone());
            aliases.reverse.insert(alias, tool.name.clone());
        }
        aliases
    }

    fn rename_request(&self, body: &mut Value) {
        if let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) {
            for tool in tools {
                rename_request_object_name(tool, &self.forward);
            }
        }
        if let Some(choice) = body.get_mut("tool_choice") {
            rename_request_object_name(choice, &self.forward);
        }
        if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
            for message in messages {
                if let Some(content) = message.get_mut("content") {
                    rename_request_name_values(content, &self.forward);
                }
            }
        }
    }

    pub(crate) fn restore_event(&self, event: &mut Value) {
        restore_name_values(event, &self.reverse);
    }
}

pub(crate) fn adapt_request(
    model: &str,
    request_context: &BTreeMap<String, String>,
    tools: &[ToolDefinition],
    mut body: Value,
) -> (Value, ClaudeOAuthToolAliases) {
    let device_id = request_context
        .get("device_id")
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("0000000000000000000000000000000000000000000000000000000000000000");
    let account_uuid = request_context
        .get("account_uuid")
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("00000000-0000-5000-8000-000000000000");
    let raw_session = request_context
        .get("session_id")
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(account_uuid);
    let session_id = stable_uuid("morphz-claude-session-v1", raw_session);

    let original_system = collect_system_text(&body);
    let message_text = last_user_text(&body);
    let fingerprint = billing_fingerprint(&message_text);
    body["system"] = json!([
        {
            "type": "text",
            "text": format!(
                "x-anthropic-billing-header: cc_version={CLAUDE_CLI_VERSION}.{fingerprint}; cc_entrypoint=cli; cch=00000;"
            )
        },
        {
            "type": "text",
            "text": CLAUDE_CLI_IDENTITY,
            "cache_control": {"type": "ephemeral", "ttl": "1h"}
        }
    ]);
    relocate_system_prompt(&mut body, model, original_system);
    inject_current_date(&mut body);

    let user_id = format!(
        "{{\"device_id\":{},\"account_uuid\":{},\"session_id\":{}}}",
        serde_json::to_string(device_id).unwrap_or_else(|_| "\"\"".to_string()),
        serde_json::to_string(account_uuid).unwrap_or_else(|_| "\"\"".to_string()),
        serde_json::to_string(&session_id).unwrap_or_else(|_| "\"\"".to_string()),
    );
    body["metadata"] = json!({"user_id": user_id});

    let aliases = ClaudeOAuthToolAliases::for_tools(tools, device_id);
    aliases.rename_request(&mut body);
    (body, aliases)
}

pub(crate) fn finalize_body(mut body: Value) -> Result<Value, String> {
    let Some(billing) = body
        .pointer("/system/0/text")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
    else {
        return Err("Claude OAuth request is missing its billing identity block".to_string());
    };
    if !billing.starts_with("x-anthropic-billing-header:") || !billing.contains("cch=00000;") {
        return Err("Claude OAuth billing identity is missing the CCH placeholder".to_string());
    }

    let mut normalized = body.clone();
    normalize_cch_value(&mut normalized);
    let bytes = serde_json::to_vec(&normalized)
        .map_err(|error| format!("serialize Claude OAuth CCH input: {error}"))?;
    let cch = format!("{:05x}", xxhash64(&bytes, CCH_SEED) & 0x0f_ffff);
    body["system"][0]["text"] =
        Value::String(billing.replacen("cch=00000;", &format!("cch={cch};"), 1));
    Ok(body)
}

pub(crate) fn betas(body: &Value) -> String {
    let mut values = vec![
        "claude-code-20250219",
        "oauth-2025-04-20",
        "interleaved-thinking-2025-05-14",
    ];
    if body
        .pointer("/thinking/display")
        .and_then(Value::as_str)
        .is_none()
    {
        values.push("redact-thinking-2026-02-12");
    }
    values.extend([
        "thinking-token-count-2026-05-13",
        "context-management-2025-06-27",
        "prompt-caching-scope-2026-01-05",
    ]);
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !uses_legacy_system_reminder(model) {
        values.push("mid-conversation-system-2026-04-07");
    }
    if body
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| !tools.is_empty())
    {
        values.push("advanced-tool-use-2025-11-20");
    }
    values.extend([
        "effort-2025-11-24",
        "fallback-credit-2026-06-01",
        "extended-cache-ttl-2025-04-11",
    ]);
    values.join(",")
}

pub(crate) fn session_id(body: &Value) -> Option<String> {
    let encoded = body.pointer("/metadata/user_id")?.as_str()?;
    serde_json::from_str::<Value>(encoded)
        .ok()?
        .get("session_id")?
        .as_str()
        .map(ToOwned::to_owned)
}

pub(crate) fn fresh_request_id() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        let digest = Sha256::digest(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos().to_le_bytes().to_vec())
                .unwrap_or_default(),
        );
        bytes.copy_from_slice(&digest[..16]);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format_uuid(bytes)
}

fn collect_system_text(body: &Value) -> Vec<String> {
    match body.get("system") {
        Some(Value::String(text)) if !text.trim().is_empty() => vec![text.clone()],
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| {
                (block.get("type").and_then(Value::as_str) == Some("text"))
                    .then(|| block.get("text").and_then(Value::as_str))
                    .flatten()
                    .filter(|text| !text.trim().is_empty())
                    .map(ToOwned::to_owned)
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn relocate_system_prompt(body: &mut Value, model: &str, system: Vec<String>) {
    if system.is_empty() {
        return;
    }
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    let Some(first_user) = messages
        .iter()
        .position(|message| message.get("role").and_then(Value::as_str) == Some("user"))
    else {
        return;
    };
    if uses_legacy_system_reminder(model) {
        let reminders = system
            .into_iter()
            .map(|text| {
                json!({
                    "type": "text",
                    "text": format!(
                        "<system-reminder>\n{text}{}\n</system-reminder>",
                        if text.ends_with('\n') { "" } else { "\n" }
                    )
                })
            })
            .collect::<Vec<_>>();
        prepend_user_blocks(&mut messages[first_user], reminders);
        return;
    }
    let inserted = system.into_iter().map(|text| {
        json!({
            "role": "system",
            "content": [{
                "type": "text",
                "text": text,
                "cache_control": {"type": "ephemeral", "ttl": "1h"}
            }]
        })
    });
    messages.splice(first_user + 1..first_user + 1, inserted);
}

fn inject_current_date(body: &mut Value) {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    let Some(first_user) = messages
        .iter()
        .position(|message| message.get("role").and_then(Value::as_str) == Some("user"))
    else {
        return;
    };
    let today = chrono::Local::now().format("%Y-%m-%d");
    let reminder = json!({
        "type": "text",
        "text": format!(
            "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is {today}.\n\n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>\n\n"
        )
    });
    prepend_user_blocks(&mut messages[first_user], vec![reminder]);
}

fn prepend_user_blocks(message: &mut Value, mut prefix: Vec<Value>) {
    let Some(object) = message.as_object_mut() else {
        return;
    };
    let content = object.remove("content").unwrap_or(Value::Array(Vec::new()));
    let mut existing = match content {
        Value::Array(blocks) => blocks,
        Value::String(text) => vec![json!({"type": "text", "text": text})],
        _ => Vec::new(),
    };
    let leading_results = existing
        .iter()
        .take_while(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
        .count();
    let tail = existing.split_off(leading_results);
    existing.append(&mut prefix);
    existing.extend(tail);
    object.insert("content".to_string(), Value::Array(existing));
}

fn last_user_text(body: &Value) -> String {
    let mut last = String::new();
    for message in body
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if message.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let candidate = match message.get("content") {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Array(blocks)) => blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .next_back()
                .unwrap_or_default()
                .to_string(),
            _ => String::new(),
        };
        if !candidate.is_empty() {
            last = candidate;
        }
    }
    last
}

fn billing_fingerprint(message: &str) -> String {
    let chars = message.chars().collect::<Vec<_>>();
    let mut input = String::from("59cf53e54c78");
    for index in [4, 7, 20] {
        input.push(chars.get(index).copied().unwrap_or('0'));
    }
    input.push_str(CLAUDE_CLI_VERSION);
    hex_prefix(&Sha256::digest(input.as_bytes()), 3)
}

fn stable_uuid(namespace: &str, value: &str) -> String {
    let digest = Sha256::digest([namespace.as_bytes(), b"\0", value.as_bytes()].concat());
    let mut bytes: [u8; 16] = digest[..16].try_into().unwrap_or([0; 16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format_uuid(bytes)
}

fn format_uuid(bytes: [u8; 16]) -> String {
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

fn is_mcp_tool_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("mcp__") else {
        return false;
    };
    rest.find("__")
        .is_some_and(|index| index > 0 && index + 2 < rest.len())
        && name.len() <= 64
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn semantic_tool_suffix(name: &str, limit: usize) -> String {
    let mut result = String::with_capacity(limit);
    let mut separator = false;
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-') {
            if separator && !result.is_empty() && result.len() < limit {
                result.push('_');
            }
            separator = false;
            if result.len() >= limit {
                break;
            }
            result.push(char::from(byte));
        } else {
            separator = !result.is_empty();
        }
    }
    let result = result.trim_matches(['_', '-']);
    if result.is_empty() {
        "tool".chars().take(limit.max(1)).collect()
    } else {
        result.to_string()
    }
}

fn rename_request_object_name(value: &mut Value, names: &BTreeMap<String, String>) {
    let mapped = value
        .get("name")
        .and_then(Value::as_str)
        .and_then(|name| names.get(name))
        .cloned();
    if let Some(mapped) = mapped {
        value["name"] = Value::String(mapped);
    }
}

fn rename_request_name_values(value: &mut Value, names: &BTreeMap<String, String>) {
    match value {
        Value::Array(values) => {
            for value in values {
                rename_request_name_values(value, names);
            }
        }
        Value::Object(object) => {
            if let Some(Value::String(name)) = object.get_mut("name") {
                if let Some(mapped) = names.get(name).cloned() {
                    *name = mapped;
                }
            }
            for value in object.values_mut() {
                rename_request_name_values(value, names);
            }
        }
        _ => {}
    }
}

fn restore_name_values(value: &mut Value, names: &HashMap<String, String>) {
    match value {
        Value::Array(values) => {
            for value in values {
                restore_name_values(value, names);
            }
        }
        Value::Object(object) => {
            if let Some(Value::String(name)) = object.get_mut("name") {
                if let Some(mapped) = names.get(name).cloned() {
                    *name = mapped;
                }
            }
            for value in object.values_mut() {
                restore_name_values(value, names);
            }
        }
        _ => {}
    }
}

fn normalize_cch_value(value: &mut Value) {
    match value {
        Value::Array(values) => {
            for value in values {
                normalize_cch_value(value);
            }
        }
        Value::Object(object) => {
            object.remove("max_tokens");
            object.remove("fallbacks");
            object.remove("fallback_credit_token");
            if object.get("model").is_some_and(Value::is_string) {
                object.insert("model".to_string(), Value::String(String::new()));
            }
            for value in object.values_mut() {
                normalize_cch_value(value);
            }
        }
        _ => {}
    }
}

fn uses_legacy_system_reminder(model: &str) -> bool {
    let model = model
        .rsplit('/')
        .next()
        .unwrap_or(model)
        .trim()
        .to_ascii_lowercase();
    matches!(
        model.as_str(),
        "claude-3-5-haiku-20241022"
            | "claude-3-5-haiku-latest"
            | "claude-3-7-sonnet-20250219"
            | "claude-3-7-sonnet-latest"
            | "claude-haiku-4-5"
            | "claude-haiku-4-5-20251001"
            | "claude-opus-4"
            | "claude-opus-4-20250514"
            | "claude-opus-4-1"
            | "claude-opus-4-1-20250805"
            | "claude-opus-4-5"
            | "claude-opus-4-5-20251101"
            | "claude-opus-4-6"
            | "claude-opus-4-7"
            | "claude-sonnet-4"
            | "claude-sonnet-4-20250514"
            | "claude-sonnet-4-5"
            | "claude-sonnet-4-5-20250929"
            | "claude-sonnet-4-6"
    )
}

fn hex_prefix(bytes: &[u8], digits: usize) -> String {
    let mut output = String::with_capacity(digits);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
        if output.len() >= digits {
            output.truncate(digits);
            break;
        }
    }
    output
}

fn xxhash64(input: &[u8], seed: u64) -> u64 {
    const P1: u64 = 11_400_714_785_074_694_791;
    const P2: u64 = 14_029_467_366_897_019_727;
    const P3: u64 = 1_609_587_929_392_839_161;
    const P4: u64 = 9_650_029_242_287_828_579;
    const P5: u64 = 2_870_177_450_012_600_261;

    fn round(mut accumulator: u64, lane: u64) -> u64 {
        accumulator = accumulator.wrapping_add(lane.wrapping_mul(P2));
        accumulator.rotate_left(31).wrapping_mul(P1)
    }
    fn merge(mut hash: u64, lane: u64) -> u64 {
        hash ^= round(0, lane);
        hash.wrapping_mul(P1).wrapping_add(P4)
    }
    fn read_u64(bytes: &[u8]) -> u64 {
        u64::from_le_bytes(bytes[..8].try_into().unwrap_or([0; 8]))
    }
    fn read_u32(bytes: &[u8]) -> u32 {
        u32::from_le_bytes(bytes[..4].try_into().unwrap_or([0; 4]))
    }

    let mut offset = 0;
    let mut hash = if input.len() >= 32 {
        let mut v1 = seed.wrapping_add(P1).wrapping_add(P2);
        let mut v2 = seed.wrapping_add(P2);
        let mut v3 = seed;
        let mut v4 = seed.wrapping_sub(P1);
        while offset + 32 <= input.len() {
            v1 = round(v1, read_u64(&input[offset..]));
            v2 = round(v2, read_u64(&input[offset + 8..]));
            v3 = round(v3, read_u64(&input[offset + 16..]));
            v4 = round(v4, read_u64(&input[offset + 24..]));
            offset += 32;
        }
        let mut hash = v1
            .rotate_left(1)
            .wrapping_add(v2.rotate_left(7))
            .wrapping_add(v3.rotate_left(12))
            .wrapping_add(v4.rotate_left(18));
        hash = merge(hash, v1);
        hash = merge(hash, v2);
        hash = merge(hash, v3);
        merge(hash, v4)
    } else {
        seed.wrapping_add(P5)
    };
    hash = hash.wrapping_add(input.len() as u64);
    while offset + 8 <= input.len() {
        let lane = round(0, read_u64(&input[offset..]));
        hash ^= lane;
        hash = hash.rotate_left(27).wrapping_mul(P1).wrapping_add(P4);
        offset += 8;
    }
    if offset + 4 <= input.len() {
        hash ^= u64::from(read_u32(&input[offset..])).wrapping_mul(P1);
        hash = hash.rotate_left(23).wrapping_mul(P2).wrapping_add(P3);
        offset += 4;
    }
    while offset < input.len() {
        hash ^= u64::from(input[offset]).wrapping_mul(P5);
        hash = hash.rotate_left(11).wrapping_mul(P1);
        offset += 1;
    }
    hash ^= hash >> 33;
    hash = hash.wrapping_mul(P2);
    hash ^= hash >> 29;
    hash = hash.wrapping_mul(P3);
    hash ^ (hash >> 32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xxhash64_matches_reference_vector() {
        assert_eq!(xxhash64(b"", 0), 0xef46_db37_51d8_e999);
    }

    #[test]
    fn tool_aliases_are_mcp_shaped_and_reversible() {
        let tools = vec![ToolDefinition {
            name: "read".to_string(),
            description: "Read a file".to_string(),
            parameters: json!({"type": "object"}),
        }];
        let aliases = ClaudeOAuthToolAliases::for_tools(&tools, &"a".repeat(64));
        let alias = aliases.forward.get("read").unwrap();
        assert!(is_mcp_tool_name(alias));
        let mut event = json!({"type": "tool_use", "name": alias});
        aliases.restore_event(&mut event);
        assert_eq!(event["name"], "read");
    }

    #[test]
    fn oauth_request_uses_cli_identity_session_and_dynamic_tool_profile() {
        let tools = vec![ToolDefinition {
            name: "read".to_string(),
            description: "Read a file".to_string(),
            parameters: json!({"type": "object"}),
        }];
        let context = BTreeMap::from([
            ("device_id".to_string(), "a".repeat(64)),
            (
                "account_uuid".to_string(),
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            ),
            ("session_id".to_string(), "morphz-session-1".to_string()),
        ]);
        let request = json!({
            "model": "claude-opus-5",
            "max_tokens": 64,
            "system": "Keep the answer concise.",
            "messages": [{"role": "user", "content": [{"type": "text", "text": "hello"}]}],
            "tools": [{"name": "read", "description": "Read a file", "input_schema": {"type": "object"}}]
        });
        let (request, aliases) = adapt_request("claude-opus-5", &context, &tools, request);

        assert!(request["system"][0]["text"].as_str().is_some_and(
            |text| text.starts_with("x-anthropic-billing-header: cc_version=2.1.258.")
        ));
        assert_eq!(request["system"][1]["text"], CLAUDE_CLI_IDENTITY);
        assert_eq!(request["messages"][1]["role"], "system");
        assert_eq!(
            request["messages"][1]["content"][0]["text"],
            "Keep the answer concise."
        );
        let encoded_user = request["metadata"]["user_id"].as_str().unwrap();
        let user: Value = serde_json::from_str(encoded_user).unwrap();
        assert_eq!(user["device_id"], "a".repeat(64));
        assert_eq!(user["account_uuid"], "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        assert!(user["session_id"]
            .as_str()
            .is_some_and(|value| value.len() == 36));

        let alias = request["tools"][0]["name"].as_str().unwrap();
        assert!(alias.starts_with("mcp__"));
        assert_eq!(aliases.reverse.get(alias).map(String::as_str), Some("read"));
        let beta = betas(&request);
        assert!(beta.contains("mid-conversation-system-2026-04-07"));
        assert!(beta.contains("advanced-tool-use-2025-11-20"));

        let request = finalize_body(request).unwrap();
        assert!(request["system"][0]["text"]
            .as_str()
            .is_some_and(|text| text.contains("cch=") && !text.contains("cch=00000;")));
    }

    #[test]
    fn legacy_claude_models_receive_system_reminders_not_system_turns() {
        let request = json!({
            "model": "claude-sonnet-4-6",
            "system": "Preserve this rule.",
            "messages": [{"role": "user", "content": "hello"}]
        });
        let (request, _) = adapt_request("claude-sonnet-4-6", &BTreeMap::new(), &[], request);
        assert!(!request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["role"] == "system"));
        assert!(request["messages"][0]["content"]
            .as_array()
            .unwrap()
            .iter()
            .any(|block| block["text"]
                .as_str()
                .is_some_and(|text| text.contains("Preserve this rule."))));
        assert!(!betas(&request).contains("mid-conversation-system-2026-04-07"));
    }
}
