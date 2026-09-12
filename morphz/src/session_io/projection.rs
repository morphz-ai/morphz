//! Deterministic, bounded views of immutable messages. A page is never a
//! replacement message and never claims that omitted data was inspected.
use super::{Content, Data, FormatBinding, IoError, IoResult, Limits, Message};
use crate::sexpr::SExpr;
use serde_json::json;
use std::collections::BTreeMap;

#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields, default)]
pub struct PageQuery {
    pub json_pointer: String,
    pub offset: usize,
    pub limit: usize,
}
impl Default for PageQuery {
    fn default() -> Self {
        Self {
            json_pointer: String::new(),
            offset: 0,
            limit: 64,
        }
    }
}

pub fn pointer<'a>(value: &'a Data, path: &str) -> IoResult<&'a Data> {
    validate_pointer(path)?;
    if path.is_empty() {
        return Ok(value);
    }
    if !path.starts_with('/') || path.len() > 2048 {
        return Err(IoError::new(
            "invalid_content_syntax",
            "Invalid JSON pointer",
        ));
    }
    let mut current = value;
    for part in path[1..].split('/') {
        let mut key = String::new();
        let mut chars = part.chars();
        while let Some(ch) = chars.next() {
            key.push(if ch == '~' {
                match chars.next() {
                    Some('0') => '~',
                    Some('1') => '/',
                    _ => {
                        return Err(IoError::new(
                            "invalid_content_syntax",
                            "Invalid JSON pointer escape",
                        ))
                    }
                }
            } else {
                ch
            });
        }
        current = match current {
            Data::Object(values) => values.get(&key),
            Data::Array(values) if key == "0" || !key.starts_with('0') => {
                key.parse::<usize>().ok().and_then(|i| values.get(i))
            }
            _ => None,
        }
        .ok_or_else(|| IoError::new("resource_unavailable", "JSON pointer does not exist"))?;
    }
    Ok(current)
}

pub fn validate_pointer(path: &str) -> IoResult<()> {
    if path.len() > 2048 || (!path.is_empty() && !path.starts_with('/')) {
        return Err(IoError::new(
            "invalid_content_syntax",
            "Invalid JSON pointer",
        ));
    }
    let mut chars = path.chars();
    while let Some(ch) = chars.next() {
        if ch == '~' && !matches!(chars.next(), Some('0' | '1')) {
            return Err(IoError::new(
                "invalid_content_syntax",
                "Invalid JSON pointer escape",
            ));
        }
    }
    Ok(())
}

fn child_path(path: &str, key: &str) -> String {
    format!("{}/{}", path, key.replace('~', "~0").replace('/', "~1"))
}

pub fn content_data(message: &Message) -> Data {
    match &message.content {
        Content::Json { value } => value.clone(),
        Content::Utf8 { value } => Data::String(value.clone()),
        Content::Resource { resource_id } => Data::from_value(&json!({"resource_id": resource_id})),
    }
}

pub fn definition_bytes(binding: &FormatBinding) -> usize {
    Data::from_value(&json!(binding))
        .expression()
        .to_string()
        .len()
}

pub fn input_overhead(binding: &super::Binding) -> usize {
    std::iter::once(&binding.input)
        .chain(&binding.accept_formats)
        .map(definition_bytes)
        .sum::<usize>()
        .saturating_add(resource_bytes(&binding.resources))
}

pub fn resource_bytes(resources: &[serde_json::Value]) -> usize {
    if resources.is_empty() {
        0
    } else {
        Data::from_value(&json!(resources))
            .expression()
            .to_string()
            .len()
            + 32
    }
}

pub fn visible_fields(message: &Message, binding: &FormatBinding) -> IoResult<Data> {
    let value = content_data(message);
    let mut fields = BTreeMap::new();
    if let Some(definition) = &binding.definition {
        for path in &definition.required_visible_paths {
            fields.insert(path.clone(), pointer(&value, path)?.clone());
        }
    }
    Ok(Data::Object(fields))
}

pub fn render(
    message: &Message,
    event_ref: &str,
    binding: Option<&FormatBinding>,
    budget: usize,
) -> SExpr {
    use SExpr::{Atom, List};
    let full = message.content.expression();
    if full.to_string().len().saturating_add(128) <= budget {
        return List(vec![
            Atom("content".into()),
            List(vec![Atom("complete".into()), Atom("true".into())]),
            full,
        ]);
    }
    let wire = message.wire_data().json();
    let fields = binding
        .and_then(|b| visible_fields(message, b).ok())
        .unwrap_or_else(|| Data::Object(BTreeMap::new()));
    let reference = Data::from_value(&json!({
        "complete": false, "reason": "context_budget", "event_id": event_ref,
        "format": message.format, "encoding": message.content.encoding(),
        "size_bytes": wire.len(), "sha256": super::hash(&message),
        "read": {"tool":"recall","event_id":event_ref,"json_pointer":"","offset":0},
        "omitted_paths": [""],
    }));
    List(vec![
        Atom("content".into()),
        List(vec![Atom("complete".into()), Atom("false".into())]),
        List(vec![
            Atom("immutable-resource".into()),
            reference.expression(),
        ]),
        List(vec![
            Atom("required-visible-fields".into()),
            fields.expression(),
        ]),
    ])
}

/// `limit` counts entries for objects/arrays, Unicode scalar values for strings.
/// Large child values become explicit path references. The caller can follow
/// that path; no partial JSON or rounded domain numbers are ever returned.
pub fn page(
    message: &Message,
    event_id: &str,
    path: &str,
    offset: usize,
    limit: usize,
    budget: usize,
) -> IoResult<Data> {
    let content = content_data(message);
    let value = pointer(&content, path)?;
    let budget = budget.clamp(2048, 32 * 1024);
    let limit = limit.clamp(
        1,
        if matches!(value, Data::String(_)) {
            20_000
        } else {
            256
        },
    );
    let mut entries = Vec::new();
    let mut omitted = false;
    let (kind, total) = match value {
        Data::Object(values) => ("object", values.len()),
        Data::Array(values) => ("array", values.len()),
        Data::String(value) => ("string", value.chars().count()),
        _ => ("scalar", 1),
    };
    if offset > total {
        return Err(IoError::new(
            "invalid_content_syntax",
            "Page offset exceeds the value length",
        ));
    }
    let mut result = Data::from_value(&json!({
        "event_id":event_id,"format":message.format,"encoding":message.content.encoding(),
        "json_pointer":path,"kind":kind,"offset":offset,"total":total,
        "next_offset":total,"complete":false,"sha256":super::hash(&message),
    }))
    .object()?
    .clone();
    let envelope = Data::Object(result.clone());
    let mut used = envelope
        .expression()
        .to_string()
        .len()
        .max(envelope.json().len())
        + 128;
    if used >= budget {
        return Err(IoError::new(
            "message_limit_exceeded",
            "Page metadata exceeds the read budget",
        ));
    }
    if let Data::String(text) = value {
        let mut fragment = String::new();
        let mut encoded_bytes = 0;
        for ch in text.chars().skip(offset).take(limit) {
            // Account for the actual envelope and JSON/S-Expr escaping.
            let bytes = serde_json::to_string(&ch.to_string())
                .expect("character")
                .len();
            if encoded_bytes + bytes > budget - used {
                break;
            }
            fragment.push(ch);
            encoded_bytes += bytes;
        }
        let end = offset + fragment.chars().count();
        if end == offset && end < total {
            return Err(IoError::new(
                "message_limit_exceeded",
                "String page cannot advance within the read budget",
            ));
        }
        result.insert(
            "next_offset".into(),
            Data::from_value(&json!((end < total).then_some(end))),
        );
        result.insert(
            "complete".into(),
            Data::Boolean(offset == 0 && end == total),
        );
        result.insert("value".into(), Data::String(fragment));
        return Ok(Data::Object(result));
    }
    let candidates: Vec<(String, Data)> = match value {
        Data::Object(values) => values
            .iter()
            .skip(offset)
            .take(limit)
            .map(|(k, v)| (child_path(path, k), v.clone()))
            .collect(),
        Data::Array(values) => values
            .iter()
            .enumerate()
            .skip(offset)
            .take(limit)
            .map(|(i, v)| (child_path(path, &i.to_string()), v.clone()))
            .collect(),
        _ if offset == 0 => vec![(path.into(), value.clone())],
        _ => vec![],
    };
    for (entry_path, child) in candidates {
        let size = child.expression().to_string().len().max(child.json().len());
        let fits = size + entry_path.len() * 6 + 128 <= budget - used;
        let mut item = BTreeMap::from([
            ("path".into(), Data::String(entry_path)),
            ("complete".into(), Data::Boolean(fits)),
        ]);
        if fits {
            item.insert("value".into(), child);
        } else {
            item.insert(
                "size_bytes".into(),
                Data::Number(child.json().len().to_string()),
            );
            item.insert("reason".into(), Data::String("follow_path".into()));
        }
        let item = Data::Object(item);
        let bytes = item.expression().to_string().len().max(item.json().len()) + 2;
        if used + bytes > budget && !entries.is_empty() {
            break;
        }
        if used + bytes > budget {
            return Err(IoError::new(
                "message_limit_exceeded",
                "A page entry path exceeds the read budget",
            ));
        }
        used += bytes;
        omitted |= !fits;
        entries.push(item);
    }
    let end = offset + entries.len();
    result.insert(
        "next_offset".into(),
        Data::from_value(&json!((end < total).then_some(end))),
    );
    result.insert(
        "complete".into(),
        Data::Boolean(offset == 0 && end == total && !omitted),
    );
    result.insert("entries".into(), Data::Array(entries));
    Ok(Data::Object(result))
}

pub fn validate_budget(
    message: &Message,
    binding: &FormatBinding,
    limits: &Limits,
    definition_size: usize,
) -> IoResult<()> {
    visible_fields(message, binding)?;
    // Reserve for a maximum-length immutable Event reference and renderer envelope.
    let view = render(
        message,
        &"e".repeat(256),
        Some(binding),
        limits.max_projection_bytes.saturating_sub(definition_size),
    );
    if view.to_string().len().saturating_add(definition_size) > limits.max_projection_bytes {
        return Err(IoError::new(
            "message_limit_exceeded",
            "Required fields and format definitions exceed the Context budget",
        ));
    }
    Ok(())
}
