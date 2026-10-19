//! Bounded, process-local draft snapshots. Durable messages remain the authority.
use crate::event::Event;
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::sync::Mutex;

const MAX_DRAFTS: usize = 64;
const MAX_DRAFT_BYTES: usize = 256 * 1024;

#[derive(Default)]
pub struct Streams {
    state: Mutex<State>,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(root: &str, attempt: &str, kind: &str, text: &str) -> Event {
        Event::new("draft".into(), "model".into(), "agent_call".into(), "runtime/model_stream".into(),
            serde_json::from_value(json!({"session_id":"s","root_turn_id":root,"model_attempt_id":attempt,"stream":{"kind":kind,"text":text}})).unwrap())
    }
    #[test]
    fn drafts_are_sequenced_bounded_and_terminal_fenced() {
        let stream = Streams::default();
        let mut first = event("r", "m", "started", "");
        stream.observe(&mut first);
        assert_eq!(first.payload["session_io_stream"]["output_id"], "io_text_m");
        for (i, text) in ["Hello", " 世界"].into_iter().enumerate() {
            let mut delta = event("r", "m", "text_delta", text);
            stream.observe(&mut delta);
            assert_eq!(
                delta.payload["session_io_stream"]["delta_seq"],
                (i + 1) as u64
            );
        }
        assert_eq!(stream.snapshots("s")[0]["text"], "Hello 世界");
        assert!(stream.snapshots("other-session").is_empty());
        let mut private = event("r", "m", "reasoning_delta", "not public");
        stream.observe(&mut private);
        assert!(!private.payload.contains_key("session_io_stream"));
        let mut terminal = event("r", "m", "completed", "");
        terminal.topic = "session/io_state".into();
        stream.observe(&mut terminal);
        let mut late = event("r", "m", "text_delta", "late");
        stream.observe(&mut late);
        assert!(!late.payload.contains_key("session_io_stream"));
        assert!(stream.snapshots("s").is_empty());
        for i in 0..100 {
            stream.observe(&mut event(
                &format!("r{i}"),
                &format!("m{i}"),
                "started",
                "",
            ));
        }
        assert_eq!(stream.snapshots("s").len(), MAX_DRAFTS);
        assert!(stream.state.lock().unwrap().order.len() <= MAX_DRAFTS);
        let mut huge = event("r99", "m99", "text_delta", &"a".repeat(MAX_DRAFT_BYTES + 1));
        stream.observe(&mut huge);
        assert_eq!(huge.payload["session_io_stream"]["type"], "stream.reset");
        assert!(!stream
            .snapshots("s")
            .iter()
            .any(|d| d["output_id"] == "io_text_m99"));
    }
    #[test]
    fn draft_snapshot_carries_actual_infer_provenance_and_first_visible_time() {
        let stream = Streams::default();
        let mut started = event("root", "attempt", "started", "");
        started
            .payload
            .insert("model_output_visibility".into(), json!("internal"));
        started.payload.insert(
            "inference_source".into(),
            json!({"plan_execution_id":"plan", "effect_sequence":2}),
        );
        stream.observe(&mut started);
        let mut text = started.clone();
        text.timestamp += chrono::Duration::seconds(1);
        text.payload.insert(
            "stream".into(),
            json!({"kind":"text_delta", "text":"typed value"}),
        );
        stream.observe(&mut text);
        let snapshot = &stream.snapshots("s")[0];
        assert_eq!(snapshot["model_output_visibility"], "internal");
        assert_eq!(snapshot["inference_source"]["plan_execution_id"], "plan");
        assert_eq!(snapshot["timestamp"], json!(text.timestamp));
        assert_eq!(snapshot["text"], "typed value");
    }
    #[test]
    fn infer_and_thread_returns_close_only_their_actual_root_draft() {
        for topic in ["plan/infer_result", "runtime/thread_result"] {
            let stream = Streams::default();
            stream.observe(&mut event("infer-root", "infer-attempt", "started", ""));
            stream.observe(&mut event(
                "infer-root",
                "infer-attempt",
                "text_delta",
                "typed value",
            ));
            stream.observe(&mut event("other-root", "other-attempt", "started", ""));
            stream.observe(&mut event(
                "other-root",
                "other-attempt",
                "text_delta",
                "other draft",
            ));
            assert_eq!(stream.snapshots("s").len(), 2);
            let mut returned = event("infer-root", "infer-attempt", "completed", "");
            returned.topic = topic.into();
            stream.observe(&mut returned);
            assert_eq!(stream.snapshots("s").len(), 1);
            assert_eq!(stream.snapshots("s")[0]["text"], "other draft");
            let mut late = event("infer-root", "infer-attempt", "text_delta", "late");
            stream.observe(&mut late);
            assert!(!late.payload.contains_key("session_io_stream"));
        }
    }
}
#[derive(Default)]
struct State {
    drafts: BTreeMap<String, Value>,
    order: VecDeque<String>,
    closed: VecDeque<String>,
}
impl Streams {
    pub fn observe(&self, event: &mut Event) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(root) = event
            .payload
            .get("root_turn_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            return;
        };
        if matches!(
            event.topic.as_str(),
            "chat/reply"
                | "chat/no_reply"
                | "chat/cancelled"
                | "session/io_state"
                | "plan/infer_result"
                | "runtime/thread_result"
        ) {
            state
                .drafts
                .retain(|_, draft| draft["root_turn_id"] != root);
            // Completed drafts must not leave an ever-growing eviction queue.
            let live_ids: std::collections::BTreeSet<_> = state.drafts.keys().cloned().collect();
            state.order.retain(|id| live_ids.contains(id));
            state.closed.push_back(root);
            if state.closed.len() > 4096 {
                state.closed.pop_front();
            }
            return;
        }
        if event.topic != "runtime/model_stream" || state.closed.contains(&root) {
            return;
        }
        let Some(attempt) = event
            .payload
            .get("model_attempt_id")
            .and_then(Value::as_str)
        else {
            return;
        };
        let output_id = format!("io_text_{attempt}");
        let Some(stream) = event.payload.get("stream") else {
            return;
        };
        let kind = stream["kind"].as_str().unwrap_or_default();
        if !matches!(kind, "started" | "text_delta" | "failed" | "incomplete") {
            return;
        }
        if !state.drafts.contains_key(&output_id) {
            while state.drafts.len() >= MAX_DRAFTS {
                if let Some(id) = state.order.pop_front() {
                    state.drafts.remove(&id);
                } else {
                    break;
                }
            }
            state.order.push_back(output_id.clone());
            state.drafts.insert(output_id.clone(), json!({"type":"output.started","output_id":output_id,"root_turn_id":root,"session_id":event.payload.get("session_id"),"thread_id":event.payload.get("thread_id"),"thread_generation":event.payload.get("thread_generation"),"activation_id":event.payload.get("activation_id"),"model_attempt_id":attempt,"model_output_visibility":event.payload.get("model_output_visibility"),"inference_source":event.payload.get("inference_source"),"timestamp":event.timestamp,"delta_seq":0,"text":"","complete":false}));
        }
        let draft = state.drafts.get_mut(&output_id).expect("draft inserted");
        if draft["aborted"] == true {
            return;
        }
        let mut update = draft.clone();
        match kind {
            "started" => {
                update["type"] = json!("output.started");
            }
            "text_delta" => {
                let text = stream["text"].as_str().unwrap_or_default();
                let current = draft["text"].as_str().unwrap_or_default();
                if current.len().saturating_add(text.len()) > MAX_DRAFT_BYTES {
                    draft["aborted"] = json!(true);
                    draft["text"] = json!("");
                    update["type"] = json!("stream.reset");
                    update["reason"] = json!("draft_buffer_exceeded; await the durable result");
                    update["text"] = json!("");
                } else {
                    let seq = draft["delta_seq"].as_u64().unwrap_or_default() + 1;
                    let first_visible = current.is_empty();
                    let prefix = format!("{current}{text}");
                    if first_visible {
                        draft["timestamp"] = json!(event.timestamp);
                        update["timestamp"] = json!(event.timestamp);
                    }
                    draft["text"] = json!(prefix);
                    draft["delta_seq"] = json!(seq);
                    update["type"] = json!("output.delta");
                    update["operation"] = json!("text.append");
                    update["text"] = json!(text);
                    update["delta_seq"] = json!(seq);
                }
            }
            _ => {
                draft["aborted"] = json!(true);
                update["type"] = json!("output.aborted");
                update["text"] = json!("");
            }
        }
        event.payload.insert("session_io_stream".into(), update);
    }
    pub fn snapshots(&self, session: &str) -> Vec<Value> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state
            .drafts
            .values()
            .filter(|draft| draft["session_id"] == session && draft["aborted"] != true)
            .cloned()
            .map(|mut draft| {
                draft["snapshot"] = json!(true);
                draft
            })
            .collect()
    }
}
