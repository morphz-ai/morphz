//! Member bodies are opened independently from a Group counter/parent page.
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupMemberCursor {
    pub ordinal: u64,
    pub thread_id: String,
}
impl GroupMemberCursor {
    pub fn encode(&self) -> String {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(self).expect("key is serializable"))
    }
    pub fn decode(
        cursor: Option<&str>,
    ) -> Result<Option<Self>, Box<dyn std::error::Error + Send + Sync>> {
        use base64::Engine;
        cursor
            .map(|cursor| {
                if cursor.len() > 2048 {
                    return Err("invalid member cursor".into());
                }
                let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(cursor)?;
                let value: Self = serde_json::from_slice(&raw)?;
                if value.ordinal > i64::MAX as u64
                    || value.thread_id.is_empty()
                    || value.thread_id.len() > 512
                {
                    return Err("invalid member cursor".into());
                }
                Ok(value)
            })
            .transpose()
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupMemberPage {
    pub group: super::ThreadGroupRecord,
    pub members: Vec<super::ThreadGroupMemberRecord>,
    pub outcomes: Vec<super::ThreadOutcomeRecord>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
}
