//! Rebuildable, Runtime-owned presentation index for one Session.
//!
//! Immutable Events remain authoritative. This index stores only their IDs,
//! causal route and ordering key; no Platform project or message body belongs
//! here. A streamed attempt has one stable entry even when its public-output
//! evidence and final reply arrive in different transactions.

use crate::event::Event;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionTimelineCursor {
    pub visible_at_micros: i64,
    pub entry_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionTimelineItem {
    pub entry_id: String,
    pub visible_at: DateTime<Utc>,
    pub visible_at_micros: i64,
    pub root_turn_id: String,
    pub attempt_id: Option<String>,
    pub display_kind: String,
    pub final_event: bool,
    pub event: Event,
    /// Joined by exact Event identity for a bounded page; not copied into the
    /// projection. The embedding product checks this input's current grant.
    pub root_event: Option<Event>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MutationKind {
    Input,
    Stream,
    Final,
    Progress,
}

#[derive(Debug, Clone)]
pub(crate) struct TimelineMutation {
    pub session_id: String,
    pub entry_id: String,
    pub source_event_id: String,
    pub source_sequence: i64,
    pub root_turn_id: String,
    pub attempt_id: Option<String>,
    pub visible_at_micros: i64,
    pub kind: MutationKind,
    pub display_kind: &'static str,
}

fn string<'a>(event: &'a Event, key: &str) -> Option<&'a str> {
    event.payload.get(key).and_then(|value| value.as_str())
}

pub(crate) fn classify(event: &Event, sequence: i64) -> Option<TimelineMutation> {
    let session_id = string(event, "session_id")?;
    let root = ["root_turn_id", "trigger_event_id", "source_turn_id"]
        .into_iter()
        .find_map(|key| super::causal_payload_string(event, key));
    let has_text = ["text", "error", "message"]
        .into_iter()
        .any(|key| string(event, key).is_some_and(|value| !value.is_empty()));
    let attempt_id = string(event, "attempt_id").filter(|value| !value.is_empty());
    let (kind, display_kind, entry_id, root_turn_id, visible_at) = match event.topic.as_str() {
        "chat/user_message" | "chat/steering" if string(event, "client_message_id").is_some() => (
            MutationKind::Input,
            "input",
            string(event, "client_message_id")?.to_string(),
            event.id.as_str(),
            event.timestamp,
        ),
        "runtime/model_public_output" if has_text => {
            let attempt = attempt_id?;
            let first_visible = string(event, "first_visible_at")?;
            let visible_at = DateTime::parse_from_rfc3339(first_visible)
                .ok()?
                .with_timezone(&Utc);
            (
                MutationKind::Stream,
                "progress",
                format!("publication:{attempt}"),
                root?,
                visible_at,
            )
        }
        "chat/reply" | "chat/outbound_message" if has_text => (
            MutationKind::Final,
            "reply",
            attempt_id
                .map(|attempt| format!("publication:{attempt}"))
                .unwrap_or_else(|| event.id.clone()),
            root?,
            event.timestamp,
        ),
        "chat/runtime_error" | "session/io_state" | "runtime/response_protocol_fused"
            if has_text =>
        {
            (
                MutationKind::Final,
                "error",
                attempt_id
                    .map(|attempt| format!("publication:{attempt}"))
                    .unwrap_or_else(|| event.id.clone()),
                root?,
                event.timestamp,
            )
        }
        "chat/progress" if has_text => (
            MutationKind::Progress,
            "progress",
            event.id.clone(),
            root?,
            event.timestamp,
        ),
        _ => return None,
    };
    Some(TimelineMutation {
        session_id: session_id.to_string(),
        entry_id,
        source_event_id: event.id.clone(),
        source_sequence: sequence,
        root_turn_id: root_turn_id.to_string(),
        attempt_id: attempt_id.map(str::to_string),
        visible_at_micros: visible_at.timestamp_micros(),
        kind,
        display_kind,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn one_attempt_keeps_the_same_publication_key_across_stream_and_final() {
        let root = Event::new(
            "root-one".into(),
            "Human".into(),
            "session_message".into(),
            "chat/user_message".into(),
            serde_json::from_value(json!({
                "session_id":"s", "client_message_id":"client-one", "root_turn_id":"root-one", "text":"question"
            }))
            .unwrap(),
        );
        let input = classify(&root, 1).unwrap();
        assert_eq!(input.entry_id, "client-one");
        assert_eq!(input.root_turn_id, "root-one");

        let mut stream = Event::new(
            "model_public_output_attempt-one".into(),
            "Model".into(),
            "runtime_control".into(),
            "runtime/model_public_output".into(),
            serde_json::from_value(json!({
                "session_id":"s", "root_turn_id":"root-one", "attempt_id":"attempt-one",
                "text":"partial", "first_visible_at":"2026-09-28T01:00:00.123456Z"
            }))
            .unwrap(),
        );
        stream.timestamp = DateTime::parse_from_rfc3339("2026-09-28T01:03:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let partial = classify(&stream, 2).unwrap();
        let mut reply = Event::new(
            "reply-one".into(),
            "Agent".into(),
            "assistant".into(),
            "chat/reply".into(),
            serde_json::from_value(json!({
                "session_id":"s", "root_turn_id":"root-one", "attempt_id":"attempt-one", "text":"complete"
            }))
            .unwrap(),
        );
        reply.timestamp = DateTime::parse_from_rfc3339("2026-09-28T01:04:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let final_reply = classify(&reply, 3).unwrap();
        assert_eq!(partial.entry_id, final_reply.entry_id);
        assert_eq!(
            partial.visible_at_micros,
            DateTime::parse_from_rfc3339("2026-09-28T01:00:00.123456Z")
                .unwrap()
                .timestamp_micros()
        );
        assert!(final_reply.visible_at_micros > partial.visible_at_micros);
    }
}
