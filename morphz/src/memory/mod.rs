pub mod sqlite;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;

// Node 顶点定义，代表实体或概念
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Node {
    pub id: String,
    pub label: String,      // Person, File, Concept, Tool 等
    pub properties: HashMap<String, JsonValue>, // JSON 格式属性
    pub embedding: Option<Vec<f32>>,  // 预留的嵌入向量
    pub is_permanent: bool,
    pub last_accessed: DateTime<Utc>,
}

// Edge 边定义，代表实体间关系
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Edge {
    pub id: String,
    pub from_node: String,
    pub to_node: String,
    pub edge_type: String,       // depends_on, created_by, owns 等 (Go 里的 Type)
    pub properties: HashMap<String, JsonValue>, // JSON 属性
    pub weight: f64,     // 连接权重
    pub is_permanent: bool,
    pub last_accessed: DateTime<Utc>,
}

#[derive(Default, Debug, Clone)]
pub struct QueryFilter {
    pub start_time: Option<DateTime<Utc>>,
    pub end_time: Option<DateTime<Utc>>,
    pub actors: Vec<String>,
    pub types: Vec<String>,
    pub topic: Option<String>, // 支持精准或前缀通配符过滤
    pub search_query: Option<String>, // 全文检索关键词
    pub vector: Vec<f32>, // 向量搜索对应的 Embedding 向量
    pub top_k: Option<usize>, // 返回的最相关事件数量限制
}

// EventStore 定义事件历史物理存储的接口
#[async_trait::async_trait]
pub trait EventStore: Send + Sync {
    async fn append(&self, ev: crate::event::Event) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
    async fn query(&self, filter: QueryFilter) -> Result<Vec<crate::event::Event>, Box<dyn std::error::Error + Send + Sync>>;
    
    // 保存 Context 状态快照
    async fn save_snapshot(
        &self, 
        _session_id: &str, 
        _step: i32, 
        _snapshot_data: &str, 
        _last_event_id: &str, 
        _last_event_time: &str
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        Ok(())
    }

    // 获取最新 Context 状态快照，返回 Option<(step, snapshot_data, last_event_id, last_event_time)>
    async fn get_latest_snapshot(
        &self, 
        _session_id: &str
    ) -> Result<Option<(i32, String, String, String)>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(None)
    }
}

// GraphStore 定义了图谱记忆物理读写的核心接口契约
#[async_trait::async_trait]
pub trait GraphStore: Send + Sync {
    async fn add_node(&self, node: Node) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
    async fn add_edge(&self, edge: Edge) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
    async fn delete_node(&self, id: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
    async fn delete_edge(&self, from_node: &str, to_node: &str, edge_type: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;

    async fn get_node(&self, id: &str) -> Result<Node, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_neighbors(&self, id: &str) -> Result<(Vec<Node>, Vec<Edge>), Box<dyn std::error::Error + Send + Sync>>;
    async fn search_nodes_by_text(&self, text: &str) -> Result<Vec<Node>, Box<dyn std::error::Error + Send + Sync>>;
    async fn search_nodes_by_embedding(&self, query_embedding: &[f32], top_k: usize) -> Result<Vec<Node>, Box<dyn std::error::Error + Send + Sync>>;
    async fn get_all_nodes_and_edges(&self) -> Result<(Vec<Node>, Vec<Edge>), Box<dyn std::error::Error + Send + Sync>>;

    async fn query_path(&self, start_node_id: &str, max_depth: usize) -> Result<(Vec<Node>, Vec<Edge>), Box<dyn std::error::Error + Send + Sync>>;
    async fn decay_and_prune(&self, decay_factor: f64, threshold: f64, inactive_seconds: i64) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
}
