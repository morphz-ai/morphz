//! A bounded, process-local view of observed discussion response activity.
//! The event log remains the authority for messages and execution outcomes.
use crate::event::Event;
use serde::Serialize;
use std::collections::VecDeque;

const MAX_TURNS: usize = 128;

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResponseActivity {
    pub input_id: String,
    pub root_id: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub phase: &'static str,
}

struct Turn {
    session: String,
    discussion: String,
    principal: String,
    response: ResponseActivity,
}

#[derive(Default)]
pub(crate) struct DiscussionActivity(VecDeque<Turn>);

impl DiscussionActivity {
    pub(crate) fn observe(&mut self, event: &Event) -> bool {
        let string = |name| event.payload.get(name).and_then(serde_json::Value::as_str);
        let phase = match event.topic.as_str() {
            "chat/user_message" if crate::event::is_input_event(event) => "waiting",
            "runtime/model_attempt_state" => match string("state") {
                Some("queued") => "queued",
                Some("streaming") => "model",
                Some("reasoning") => "reasoning",
                Some("waiting_final_output") => "final_output",
                Some("streaming_text") => "generating",
                Some("generating_tool_call") => "tool_call",
                Some("settling" | "completed") => "settling",
                _ => return false,
            },
            "runtime/tool_calls_selected" => "tool",
            "chat/tool_output" => "settling",
            "chat/progress" | "runtime/provider_wait"
                if string("disposition") == Some("provider_wait") =>
            {
                "provider_wait"
            }
            "chat/reply"
            | "chat/outbound_message"
            | "chat/no_reply"
            | "chat/cancelled"
            | "runtime/thread_cancelled"
            | "runtime/thread_result"
            | "runtime/thread_waiting"
            | "chat/runtime_error"
            | "runtime/response_protocol_fused"
            | "session/io_state" => "settled",
            _ => return false,
        };
        let (Some(session), Some(root)) = (string("session_id"), string("root_turn_id")) else {
            return false;
        };
        let existing = self
            .0
            .iter()
            .position(|turn| turn.session == session && turn.response.root_id == root);
        if phase == "waiting" {
            let discussion = event
                .payload
                .get("discussion")
                .and_then(|value| value["id"].as_str());
            let (Some(discussion), Some(input_id), Some(principal)) = (
                discussion,
                string("client_message_id"),
                string("principal_id"),
            ) else {
                return false;
            };
            if existing.is_some() || root != event.id || root.len() > 512 || input_id.len() > 512 {
                return false;
            }
            if self.0.len() == MAX_TURNS {
                // Evict finished presentation state before a live response.
                if let Some(index) = self
                    .0
                    .iter()
                    .position(|turn| turn.response.phase == "settled")
                {
                    self.0.remove(index);
                } else {
                    self.0.pop_front();
                }
            }
            self.0.push_back(Turn {
                session: session.into(),
                discussion: discussion.into(),
                principal: principal.into(),
                response: ResponseActivity {
                    input_id: input_id.into(),
                    root_id: root.into(),
                    created_at: event.timestamp,
                    phase: "waiting",
                },
            });
            return true;
        }
        let Some(turn) = existing.and_then(|index| self.0.get_mut(index)) else {
            return false;
        };
        if turn.response.phase == "settled"
            || matches!(
                string("model_output_visibility"),
                Some("internal" | "evaluation")
            )
        {
            return false;
        }
        if turn.response.phase == phase {
            return false;
        }
        turn.response.phase = phase;
        true
    }

    pub(crate) fn snapshot(
        &self,
        session: &str,
        discussion: &str,
        principal: Option<&str>,
    ) -> Vec<ResponseActivity> {
        self.0
            .iter()
            .filter(|turn| {
                turn.session == session
                    && turn.discussion == discussion
                    && principal.is_none_or(|id| turn.principal == id)
            })
            .map(|turn| turn.response.clone())
            .collect()
    }
}
