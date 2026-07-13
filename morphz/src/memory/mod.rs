pub mod sqlite;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Active,
    Archived,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentRecord {
    pub id: String,
    pub title: String,
    pub status: SessionStatus,
    pub root_context_id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct NewAgent {
    pub id: String,
    pub title: String,
    pub root_context_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentBootstrapRecord {
    pub agent: AgentRecord,
    pub root_context: CognitiveContextRecord,
    pub initial_session: SessionRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CognitiveContextRecord {
    pub id: String,
    pub agent_id: String,
    pub title: String,
    pub status: SessionStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed_context_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed_context_version: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed_snapshot_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed_projection: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewCognitiveContext {
    pub id: String,
    pub agent_id: String,
    pub title: String,
}

impl SessionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Archived => "archived",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionRecord {
    pub id: String,
    pub agent_id: String,
    /// Immutable attachment to the Cognitive Context that owns the shared Mind.
    pub context_id: String,
    pub parent_session_id: Option<String>,
    pub title: String,
    pub status: SessionStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_activity_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionMountKind {
    ExistingContext,
    NewBlankContext,
    NewContextFromMind,
    DelegationProjection,
}

impl SessionMountKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ExistingContext => "existing_context",
            Self::NewBlankContext => "new_blank_context",
            Self::NewContextFromMind => "new_context_from_mind",
            Self::DelegationProjection => "delegation_projection",
        }
    }
}

#[derive(Debug, Clone)]
pub struct NewSession {
    pub id: String,
    pub agent_id: String,
    pub context_id: String,
    pub parent_session_id: Option<String>,
    pub title: String,
    pub mount_kind: SessionMountKind,
}

#[derive(Debug, Clone, Default)]
pub struct SessionUpdate {
    pub title: Option<String>,
    pub status: Option<SessionStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DelegationStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl DelegationStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DelegationRecord {
    pub id: String,
    pub agent_id: String,
    pub parent_context_id: String,
    pub parent_session_id: String,
    pub child_context_id: String,
    pub child_session_id: String,
    pub task: String,
    pub success_when: Option<String>,
    pub context_scope: String,
    pub status: DelegationStatus,
    pub result_event_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct NewDelegation {
    pub id: String,
    pub agent_id: String,
    pub parent_context_id: String,
    pub parent_session_id: String,
    pub child_context_id: String,
    pub child_session_id: String,
    pub task: String,
    pub success_when: Option<String>,
    pub context_scope: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MessageClaim {
    Accepted,
    Existing { event_id: String },
}

// Node 顶点定义，代表实体或概念
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Node {
    pub id: String,
    pub label: String,                          // Person, File, Concept, Tool 等
    pub properties: HashMap<String, JsonValue>, // JSON 格式属性
    pub embedding: Option<Vec<f32>>,            // 预留的嵌入向量
    pub is_permanent: bool,
    pub last_accessed: DateTime<Utc>,
}

// Edge 边定义，代表实体间关系
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Edge {
    pub id: String,
    pub from_node: String,
    pub to_node: String,
    pub edge_type: String, // depends_on, created_by, owns 等 (Go 里的 Type)
    pub properties: HashMap<String, JsonValue>, // JSON 属性
    pub weight: f64,       // 连接权重
    pub is_permanent: bool,
    pub last_accessed: DateTime<Utc>,
}

#[derive(Default, Debug, Clone)]
pub struct QueryFilter {
    pub context_id: Option<String>,
    pub session_id: Option<String>,
    pub start_time: Option<DateTime<Utc>>,
    pub end_time: Option<DateTime<Utc>>,
    pub actors: Vec<String>,
    pub types: Vec<String>,
    pub topic: Option<String>,        // 支持精准或前缀通配符过滤
    pub search_query: Option<String>, // 全文检索关键词
    pub vector: Vec<f32>,             // 向量搜索对应的 Embedding 向量
    pub top_k: Option<usize>,         // 返回的最相关事件数量限制
}

// EventStore 定义事件历史物理存储的接口
#[async_trait::async_trait]
pub trait EventStore: Send + Sync {
    async fn append(
        &self,
        ev: crate::event::Event,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
    async fn query(
        &self,
        filter: QueryFilter,
    ) -> Result<Vec<crate::event::Event>, Box<dyn std::error::Error + Send + Sync>>;
}

/// Persistent product-level Session directory. It deliberately owns routing and
/// lifecycle metadata only; Mind semantics remain in the Context event stream.
#[async_trait::async_trait]
pub trait SessionStore: Send + Sync {
    async fn create_agent_bundle(
        &self,
        agent: NewAgent,
        root_context: NewCognitiveContext,
        initial_session: NewSession,
    ) -> Result<AgentBootstrapRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn create_agent(
        &self,
        agent: NewAgent,
    ) -> Result<AgentRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn ensure_agent(
        &self,
        agent: NewAgent,
    ) -> Result<AgentRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_agent(
        &self,
        id: &str,
    ) -> Result<Option<AgentRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_agents(
        &self,
        include_archived: bool,
    ) -> Result<Vec<AgentRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn create_context(
        &self,
        context: NewCognitiveContext,
    ) -> Result<CognitiveContextRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn ensure_context(
        &self,
        context: NewCognitiveContext,
    ) -> Result<CognitiveContextRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_context(
        &self,
        id: &str,
    ) -> Result<Option<CognitiveContextRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_contexts(
        &self,
        include_archived: bool,
    ) -> Result<Vec<CognitiveContextRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn set_context_seed(
        &self,
        context_id: &str,
        source_context_id: &str,
        source_version: u64,
        snapshot_hash: &str,
        projection: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
    async fn create_session(
        &self,
        session: NewSession,
    ) -> Result<SessionRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn ensure_session(
        &self,
        session: NewSession,
    ) -> Result<SessionRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_session(
        &self,
        id: &str,
    ) -> Result<Option<SessionRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_sessions(
        &self,
        include_archived: bool,
    ) -> Result<Vec<SessionRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_context_sessions(
        &self,
        context_id: &str,
        include_archived: bool,
    ) -> Result<Vec<SessionRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn update_session(
        &self,
        id: &str,
        update: SessionUpdate,
    ) -> Result<Option<SessionRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn touch_session(
        &self,
        id: &str,
        at: DateTime<Utc>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
    async fn claim_message(
        &self,
        session_id: &str,
        client_message_id: &str,
        event: &crate::event::Event,
    ) -> Result<MessageClaim, Box<dyn std::error::Error + Send + Sync>>;
    async fn create_delegation(
        &self,
        delegation: NewDelegation,
    ) -> Result<DelegationRecord, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_delegation(
        &self,
        id: &str,
    ) -> Result<Option<DelegationRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_delegation_by_child_session(
        &self,
        child_session_id: &str,
    ) -> Result<Option<DelegationRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn list_delegations(
        &self,
    ) -> Result<Vec<DelegationRecord>, Box<dyn std::error::Error + Send + Sync>>;
    async fn update_delegation_status(
        &self,
        id: &str,
        status: DelegationStatus,
        result_event_id: Option<&str>,
    ) -> Result<Option<DelegationRecord>, Box<dyn std::error::Error + Send + Sync>>;
}

// GraphStore 定义了图谱记忆物理读写的核心接口契约
#[async_trait::async_trait]
pub trait GraphStore: Send + Sync {
    async fn add_node(&self, node: Node) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
    async fn add_edge(&self, edge: Edge) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
    async fn delete_node(&self, id: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
    async fn delete_edge(
        &self,
        from_node: &str,
        to_node: &str,
        edge_type: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;

    async fn get_node(&self, id: &str) -> Result<Node, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_neighbors(
        &self,
        id: &str,
    ) -> Result<(Vec<Node>, Vec<Edge>), Box<dyn std::error::Error + Send + Sync>>;
    async fn search_nodes_by_text(
        &self,
        text: &str,
    ) -> Result<Vec<Node>, Box<dyn std::error::Error + Send + Sync>>;
    async fn search_nodes_by_embedding(
        &self,
        query_embedding: &[f32],
        top_k: usize,
    ) -> Result<Vec<Node>, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_all_nodes_and_edges(
        &self,
    ) -> Result<(Vec<Node>, Vec<Edge>), Box<dyn std::error::Error + Send + Sync>>;

    async fn query_path(
        &self,
        start_node_id: &str,
        max_depth: usize,
    ) -> Result<(Vec<Node>, Vec<Edge>), Box<dyn std::error::Error + Send + Sync>>;
    async fn decay_and_prune(
        &self,
        decay_factor: f64,
        threshold: f64,
        inactive_seconds: i64,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;

    /// 事务批量写入：在单个 SQL 事务中原子性地写入多个节点和边。
    /// 中途失败将自动回滚，避免脏数据。默认实现回退到逐条 add_node/add_edge（不具备原子性）。
    async fn bulk_upsert_in_transaction(
        &self,
        nodes: Vec<Node>,
        edges: Vec<Edge>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        for node in nodes {
            self.add_node(node).await?;
        }
        for edge in edges {
            self.add_edge(edge).await?;
        }
        Ok(())
    }
}
