//! Deliberately bounded JSON Schema subset. Unsupported keywords fail at install.
use super::{Data, IoError, IoResult};
use serde_json::Value;

pub const KEYWORDS: &[&str] = &[
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "const",
    "description",
];

pub fn check(schema: &Value, depth: usize) -> IoResult<()> {
    if depth > 32 {
        return Err(IoError::new(
            "message_limit_exceeded",
            "Schema nesting exceeds limit",
        ));
    }
    let object = schema
        .as_object()
        .ok_or_else(|| IoError::new("schema_validation_unavailable", "Schema must be an object"))?;
    for (name, value) in object {
        let valid = match name.as_str() {
            "type" => value.as_str().is_some_and(|kind| {
                [
                    "object", "array", "string", "number", "integer", "boolean", "null",
                ]
                .contains(&kind)
            }),
            "description" => value.as_str().is_some_and(|text| text.len() <= 8192),
            "required" => value
                .as_array()
                .is_some_and(|items| items.iter().all(Value::is_string)),
            "additionalProperties" => value.is_boolean(),
            "enum" => {
                value.as_array().is_some_and(|items| !items.is_empty())
                    && exact_schema_constant(value)
            }
            "const" => exact_schema_constant(value),
            "properties" => {
                let properties = value.as_object().ok_or_else(|| {
                    IoError::new(
                        "schema_validation_unavailable",
                        "properties must be an object",
                    )
                })?;
                for nested in properties.values() {
                    check(nested, depth + 1)?;
                }
                true
            }
            "items" => {
                check(value, depth + 1)?;
                true
            }
            _ => false,
        };
        if !valid {
            return Err(IoError::new(
                "schema_validation_unavailable",
                format!("Unsupported or malformed schema keyword: {name}"),
            ));
        }
    }
    Ok(())
}

// Descriptors currently use serde_json::Value. Reject floating-point constants
// instead of validating against a rounded install-time value. Domain message
// numbers remain lossless; only this explicitly advertised Schema subset is narrow.
fn exact_schema_constant(value: &Value) -> bool {
    match value {
        Value::Number(number) => number.is_i64() || number.is_u64(),
        Value::Array(items) => items.iter().all(exact_schema_constant),
        Value::Object(fields) => fields.values().all(exact_schema_constant),
        _ => true,
    }
}

pub fn validate(schema: &Value, value: &Data, path: &str) -> IoResult<()> {
    let fail = || {
        IoError::new(
            "schema_validation_failed",
            format!("Schema validation failed at JSON pointer {path:?}"),
        )
    };
    if let Some(kind) = schema.get("type").and_then(Value::as_str) {
        let matches = matches!(
            (kind, value),
            ("object", Data::Object(_))
                | ("array", Data::Array(_))
                | ("string", Data::String(_))
                | ("number", Data::Number(_))
                | ("boolean", Data::Boolean(_))
                | ("null", Data::Null)
        ) || matches!((kind, value), ("integer",Data::Number(number)) if normalized_number(number).2 >= 0);
        if !matches {
            return Err(fail());
        }
    }
    if let Some(constant) = schema.get("const") {
        if !equivalent(value, &Data::from_value(constant)) {
            return Err(fail());
        }
    }
    if let Some(items) = schema.get("enum").and_then(Value::as_array) {
        if !items
            .iter()
            .any(|item| equivalent(value, &Data::from_value(item)))
        {
            return Err(fail());
        }
    }
    if let Data::Object(properties) = value {
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            if required
                .iter()
                .any(|key| !properties.contains_key(key.as_str().unwrap_or_default()))
            {
                return Err(fail());
            }
        }
        for (key, value) in properties {
            let child = format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"));
            if let Some(rule) = schema
                .get("properties")
                .and_then(|properties| properties.get(key))
            {
                validate(rule, value, &child)?;
            } else if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
                return Err(fail());
            }
        }
    }
    if let Data::Array(items) = value {
        if let Some(rule) = schema.get("items") {
            for (index, value) in items.iter().enumerate() {
                validate(rule, value, &format!("{path}/{index}"))?;
            }
        }
    }
    Ok(())
}

// JSON Schema numeric equality is mathematical; idempotency deliberately remains
// lexical. No float conversion and no allocation proportional to the exponent.
fn normalized_number(number: &str) -> (bool, String, i64) {
    let negative = number.starts_with('-');
    let unsigned = number.trim_start_matches('-');
    let (mantissa, exponent) = unsigned.split_once(['e', 'E']).unwrap_or((unsigned, "0"));
    let exponent = exponent
        .parse::<i64>()
        .unwrap_or(if exponent.starts_with('-') {
            i64::MIN
        } else {
            i64::MAX
        });
    let fractional = mantissa
        .split_once('.')
        .map_or(0, |(_, fraction)| fraction.len() as i64);
    let digits = mantissa.replace('.', "");
    let digits = digits.trim_start_matches('0');
    if digits.is_empty() {
        return (false, "0".into(), 0);
    }
    let coefficient = digits.trim_end_matches('0');
    (
        negative,
        coefficient.into(),
        exponent
            .saturating_sub(fractional)
            .saturating_add((digits.len() - coefficient.len()) as i64),
    )
}
fn equivalent(left: &Data, right: &Data) -> bool {
    match (left, right) {
        (Data::Number(left), Data::Number(right)) => {
            normalized_number(left) == normalized_number(right)
        }
        (Data::Array(left), Data::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| equivalent(left, right))
        }
        (Data::Object(left), Data::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, value)| {
                    right.get(key).is_some_and(|right| equivalent(value, right))
                })
        }
        _ => left == right,
    }
}
