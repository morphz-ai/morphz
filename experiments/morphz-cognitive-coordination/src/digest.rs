use crate::error::{CoordinationError, CoordinationResult};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub fn stable_digest<T: Serialize>(value: &T) -> CoordinationResult<String> {
    let value = serde_json::to_value(value)?;
    let mut canonical = Vec::new();
    write_canonical_json(&value, &mut canonical)?;
    Ok(format!("sha256:{:x}", Sha256::digest(canonical)))
}

fn write_canonical_json(value: &Value, output: &mut Vec<u8>) -> CoordinationResult<()> {
    match value {
        Value::Null => output.extend_from_slice(b"null"),
        Value::Bool(value) => output.extend_from_slice(if *value { b"true" } else { b"false" }),
        Value::Number(value) => output.extend_from_slice(value.to_string().as_bytes()),
        Value::String(value) => output.extend_from_slice(serde_json::to_string(value)?.as_bytes()),
        Value::Array(values) => {
            output.push(b'[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                write_canonical_json(value, output)?;
            }
            output.push(b']');
        }
        Value::Object(values) => {
            output.push(b'{');
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                output.extend_from_slice(serde_json::to_string(key)?.as_bytes());
                output.push(b':');
                let child = values.get(key).ok_or_else(|| {
                    CoordinationError::Serialization(format!(
                        "canonical JSON key '{key}' disappeared while serializing"
                    ))
                })?;
                write_canonical_json(child, output)?;
            }
            output.push(b'}');
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::stable_digest;
    use serde_json::json;

    #[test]
    fn object_key_order_does_not_change_the_digest() {
        let left = json!({"a": 1, "b": {"x": true, "y": false}});
        let right = json!({"b": {"y": false, "x": true}, "a": 1});
        assert_eq!(
            stable_digest(&left).unwrap(),
            stable_digest(&right).unwrap()
        );
    }
}
