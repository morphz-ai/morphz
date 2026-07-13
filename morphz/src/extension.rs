use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;

pub type ExtensionError = Box<dyn std::error::Error + Send + Sync>;

/// Provider-neutral recall request. Core owns only this semantic seam; a
/// provider may use text search, vectors, a graph, a remote service, or any
/// future retrieval strategy without changing Context semantics.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecallRequest {
    pub query: String,
    pub limit: usize,
    pub context_id: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecallCandidate {
    pub id: String,
    pub text: String,
    pub score: Option<f32>,
    #[serde(default)]
    pub metadata: HashMap<String, JsonValue>,
}

#[async_trait::async_trait]
pub trait RecallProvider: Send + Sync {
    fn id(&self) -> &'static str;

    async fn recall(&self, request: RecallRequest) -> Result<Vec<RecallCandidate>, ExtensionError>;
}
