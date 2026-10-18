//! Bounded, authorized Event evidence, not a public draft or provider HTTP log.
//! Capture only the assistant response: never credentials, headers or reasoning.
use crate::llm::Response;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{self, Write};

const MAX_CAPTURE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Default)]
struct Capture {
    bytes: Vec<u8>,
    total: usize,
    digest: Sha256,
}

impl Write for Capture {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.digest.update(bytes);
        self.total = self.total.saturating_add(bytes.len());
        let available = MAX_CAPTURE_BYTES.saturating_sub(self.bytes.len());
        self.bytes
            .extend_from_slice(&bytes[..bytes.len().min(available)]);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub fn response_capture(response: Option<&Response>) -> Value {
    let Some(response) = response else {
        return json!({"state":"unavailable", "stage":"provider_adapter_output_before_annotation_normalization"});
    };
    let mut capture = Capture::default();
    if serde_json::to_writer(&mut capture, response).is_err() {
        return json!({"state":"serialization_failed", "stage":"provider_adapter_output_before_annotation_normalization"});
    }
    let complete = capture.total <= MAX_CAPTURE_BYTES;
    let mut result = json!({
        "state":if complete {"complete"} else {"truncated"},
        "stage":"provider_adapter_output_before_annotation_normalization",
        "byte_count":capture.total,
        "sha256":format!("{:x}", capture.digest.finalize()),
    });
    if complete {
        result["raw_response"] =
            serde_json::from_slice(&capture.bytes).expect("serialized Response");
    } else {
        // A partial JSON prefix is explicitly not a complete raw response.
        result["utf8_json_prefix"] = String::from_utf8_lossy(&capture.bytes).into_owned().into();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::ToolCallRepr;

    #[test]
    fn complete_capture_preserves_exact_control_args_and_unicode_without_reasoning() {
        let response = Response {
            content: "中文🧠".into(),
            tool_calls: vec![ToolCallRepr {
                id: "r".into(),
                r#type: "function".into(),
                func_name: "reply".into(),
                arguments: r#"{ "content":"原文", "annotations":null }"#.into(),
            }],
        };
        let capture = response_capture(Some(&response));
        assert_eq!(capture["state"], "complete");
        assert_eq!(
            capture["raw_response"],
            serde_json::to_value(&response).unwrap()
        );
        let raw = serde_json::to_vec(&response).unwrap();
        assert_eq!(capture["sha256"], format!("{:x}", Sha256::digest(&raw)));
        assert_eq!(capture["byte_count"], raw.len());
        assert_eq!(response_capture(None)["state"], "unavailable");
    }

    #[test]
    fn oversized_capture_has_explicit_limit_and_full_digest_not_false_completeness() {
        let response = Response {
            content: "🧠".repeat(MAX_CAPTURE_BYTES),
            tool_calls: vec![],
        };
        let capture = response_capture(Some(&response));
        assert_eq!(capture["state"], "truncated");
        assert!(capture.get("raw_response").is_none());
        assert!(capture["utf8_json_prefix"].as_str().unwrap().len() <= MAX_CAPTURE_BYTES + 3);
        assert_eq!(
            capture["sha256"],
            format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&response).unwrap())
            )
        );
    }
}
