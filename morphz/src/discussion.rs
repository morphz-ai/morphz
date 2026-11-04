//! Native presentation scopes for passage discussions. Session, Context and
//! execution authority do not come from these client-owned source locators.
use crate::event::Event;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_SOURCE_BYTES: usize = 128 * 1024;
pub const MAX_PAGE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_PAGE_ROWS: usize = 50;

#[derive(Debug)]
pub struct PageBudgetBoundary {
    pub entry_id: String,
    pub event_id: String,
    pub root_turn_id: String,
    pub visible_at_micros: i64,
    pub display_kind: String,
    pub attempt_id: Option<String>,
    pub final_event: bool,
    pub content_bytes: i64,
}
impl std::fmt::Display for PageBudgetBoundary {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Discussion message requires an explicit content read")
    }
}
impl std::error::Error for PageBudgetBoundary {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageChunk {
    pub id: String,
    pub event_id: String,
    pub root_id: String,
    pub created_at_micros: i64,
    pub kind: String,
    pub text: String,
    pub next_offset: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DiscussionSource {
    pub key: String,
    pub title: String,
    pub text: String,
    /// A versioned client locator, never an authorization grant.
    pub locator: Value,
}

impl DiscussionSource {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.key.is_empty()
            || self.key.len() > 512
            || self.key.chars().any(char::is_control)
            || self.title.trim().is_empty()
            || self.title.chars().count() > 500
            || self.text.trim().is_empty()
            || self.text.chars().count() > 30_000
            || !self.locator.is_object()
            || serde_json::to_vec(&self.locator)
                .map_err(|_| "Invalid source locator")?
                .len()
                > 16 * 1024
            || serde_json::to_vec(self)
                .map_err(|_| "Invalid discussion source")?
                .len()
                > MAX_SOURCE_BYTES
        {
            return Err("Discussion source exceeds its declared bounds");
        }
        Ok(())
    }
}

/// The first command ID is the discussion identity. Subsequent commands name
/// that accepted input; they cannot replace its source or publication choice.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DiscussionInput {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<DiscussionSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publish_to_session: Option<bool>,
}

impl DiscussionInput {
    pub fn validate(&self, client_message_id: &str) -> Result<(), &'static str> {
        if self.id.is_empty()
            || self.id.len() > 128
            || self.id.chars().any(|c| c.is_control() || c.is_whitespace())
        {
            return Err("Invalid discussion identity");
        }
        if self.id == client_message_id {
            self.source
                .as_ref()
                .ok_or("A new discussion requires its source")?
                .validate()?;
        } else if self.source.is_some() || self.publish_to_session.is_some() {
            return Err("An existing discussion's source and publication are immutable");
        }
        Ok(())
    }
}

pub fn from_event(event: &Event) -> Result<Option<DiscussionInput>, serde_json::Error> {
    event
        .payload
        .get("discussion")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscussionDescriptor {
    pub id: String,
    pub session_id: String,
    pub principal_id: String,
    pub source_event_id: String,
    pub source_key: String,
    pub title: String,
    pub preview: String,
    pub locator: Value,
    pub publish_to_session: bool,
    pub created_at_micros: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscussionRootRoute {
    pub discussion_id: String,
    pub principal_id: String,
    pub main_visible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscussionCursor {
    pub created_at_micros: i64,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TimelineScope {
    Main,
    Discussion { id: String },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn first() -> DiscussionInput {
        DiscussionInput {
            id: "command-a".into(),
            source: Some(DiscussionSource {
                key: "message:session-a:event-a:3:7".into(),
                title: "A source message".into(),
                text: "passage".into(),
                locator: json!({"event_id":"event-a", "anchor":{"start":3,"end":7}}),
            }),
            publish_to_session: None,
        }
    }

    #[test]
    fn first_input_and_continuation_have_distinct_immutable_shapes() {
        assert!(first().validate("command-a").is_ok());
        assert!(first().validate("command-b").is_err());
        let continuation = DiscussionInput {
            id: "command-a".into(),
            source: None,
            publish_to_session: None,
        };
        assert!(continuation.validate("command-b").is_ok());
        assert!(continuation.validate("command-a").is_err());
        let mut changed = continuation;
        changed.publish_to_session = Some(true);
        assert!(changed.validate("command-b").is_err());
    }

    #[test]
    fn source_and_native_route_are_bounded_and_not_response_annotations() {
        let mut input = first();
        input.source.as_mut().unwrap().text = "x".repeat(30_001);
        assert!(input.validate("command-a").is_err());
        assert!(serde_json::from_value::<DiscussionInput>(
            json!({"id":"a","response_annotations":"on"})
        )
        .is_err());
        assert_eq!(
            serde_json::from_value::<DiscussionInput>(json!(first())).unwrap(),
            first()
        );
        assert!(
            serde_json::from_value::<DiscussionInput>(json!({"id":"a","unknown":true})).is_err()
        );
    }
}
