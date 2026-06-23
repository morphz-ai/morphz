use crate::llm::{Client, Message};
use crate::memory::{EventStore, GraphStore, Node, Edge, QueryFilter};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedRelation {
    pub from: String,
    #[serde(rename = "from_type")]
    pub from_type: String,
    pub to: String,
    #[serde(rename = "to_type")]
    pub to_type: String,
    pub relation: String,
}

pub struct Curator {
    store: Arc<dyn EventStore>,
    graph_store: Option<Arc<dyn GraphStore>>,
    client: Arc<dyn Client>,
}

impl Curator {
    pub fn new(store: Arc<dyn EventStore>, graph_store: Option<Arc<dyn GraphStore>>, client: Arc<dyn Client>) -> Self {
        Self { store, graph_store, client }
    }


    pub fn extract_and_store(self: Arc<Self>, session_id: String) {
        let curator = Arc::clone(&self);
        tokio::spawn(async move {
            if let Err(e) = curator.extract_and_store_impl(&session_id).await {
                eprintln!("⚠️ [Curator] 异步知识提炼失败: {:?}", e);
            }
        });
    }

    async fn extract_and_store_impl(&self, session_id: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // 1. 从 EventStore 中查询当前 Session 的最近事件，构建对话片段
        let filter = QueryFilter {
            topic: Some("chat/*".to_string()),
            ..Default::default()
        };

        let events = self.store.query(filter).await?;

        // 只保留当前 session 的最近 4 条消息
        let mut session_events = Vec::new();
        for ev in events {
            if let Some(sess) = ev.payload.get("session_id").and_then(|s| s.as_str()) {
                if sess == session_id {
                    session_events.push(ev);
                }
            }
        }

        if session_events.is_empty() {
            return Ok(());
        }

        let slice_start = if session_events.len() > 4 {
            session_events.len() - 4
        } else {
            0
        };
        let recent_events = &session_events[slice_start..];

        // 构建文本上下文
        let mut conversation_text = String::new();
        for ev in recent_events {
            if let Some(text) = ev.payload.get("text").and_then(|s| s.as_str()) {
                let mut actor = ev.actor.as_str();
                if ev.event_type == crate::event::TYPE_USER_MESSAGE {
                    actor = "User";
                }
                conversation_text.push_str(&format!("{}: {}\n", actor, text));
            }
        }

        if conversation_text.is_empty() {
            return Ok(());
        }

        println!("🔍 [Curator] 启动异步知识提炼...");

        // 2. 调用 LLM 提炼实体关系
        let relations = self.extract_relations(&conversation_text).await?;
        if relations.is_empty() {
            println!("🔍 [Curator] 本轮对话未提炼出新知识。");
            return Ok(());
        }

        // 3. 将提炼的实体和关系落入 GraphStore
        // 这里需要将 EventStore 动态转型为 GraphStore
        // 在 Rust 中，我们可以通过将 self.store 指针 downcast 或直接要求 store 必须实现 GraphStore。
        // 由于我们的存储 SqliteStore 同时实现了 EventStore 和 GraphStore，我们可以使用 std::any 或更简单的模式：
        // 直接在 Curator 初始化时，传入一个 Arc<SqliteStore> 或持有 `Arc<dyn GraphStore>`。
        // 为了和 Go 端的动态类型断言一致，且由于我们的 SqliteStore 实现了两个接口，
        // 我们可以直接在 Curator 中把 `store` 保存为 `Arc<dyn GraphStore>` 吗？因为 GraphStore 并不继承 EventStore。
        // 实际上，为了架构的简明，Curator 需要读写 Event 也要读写 Graph，我们可以直接要求 `store` 必须是 `Arc<crate::memory::sqlite::SqliteStore>`，或者通过一个联合 Trait，或者最实用的方式是：
        // Curator 在创建时，同时传入 `store: Arc<dyn EventStore>` 和 `graph_store: Option<Arc<dyn GraphStore>>`。这样在动态转型上更加优雅且类型安全！
        // 让我们看看，`morphz` 中我们是否能动态断言。既然我们知道存储后端是 SQLite，在启动时把 SqliteStore 的同一个 Arc 实例分别包装成 `Arc<dyn EventStore>` 和 `Arc<dyn GraphStore>` 传给 Curator，这就做到了完美的接口隔离。
        // 对！我们在 Curator 结构体定义中，加入 `graph_store: Option<Arc<dyn GraphStore>>`。
        // 这样代码干净利落。

        let graph_store = match self.get_graph_store() {
            Some(gs) => gs,
            None => {
                println!("⚠️ [Curator] store 未实现 GraphStore 接口，跳过图谱写入");
                return Ok(());
            }
        };

        for rel in relations {
            let from_node = rel.from.trim().to_string();
            let to_node = rel.to.trim().to_string();
            let relation = rel.relation.trim().to_uppercase();

            let mut from_type = rel.from_type.trim().to_string();
            if from_type.is_empty() {
                from_type = "Concept".to_string();
            }
            let mut to_type = rel.to_type.trim().to_string();
            if to_type.is_empty() {
                to_type = "Concept".to_string();
            }

            if from_node.is_empty() || to_node.is_empty() || relation.is_empty() {
                continue;
            }

            let from_id = from_node.to_lowercase();
            let to_id = to_node.to_lowercase();

            // 1. 获取/计算 fromNode Embedding 缓存
            let mut from_emb = None;
            if let Ok(existing) = graph_store.get_node(&from_id).await {
                if existing.embedding.is_some() {
                    from_emb = existing.embedding;
                }
            }
            if from_emb.is_none() {
                if let Ok(vec) = self.client.create_embedding(&from_node).await {
                    from_emb = Some(vec);
                }
            }

            // 写入 Node
            let mut from_props = HashMap::new();
            from_props.insert("name".to_string(), serde_json::json!(from_node));

            let f_node = Node {
                id: from_id.clone(),
                label: from_type.clone(),
                properties: from_props,
                embedding: from_emb,
                is_permanent: false,
                last_accessed: Utc::now(),
            };
            if let Err(e) = graph_store.add_node(f_node).await {
                eprintln!("⚠️ [Curator] 写入节点 {} 失败: {:?}", from_id, e);
                continue;
            }

            // 2. 获取/计算 toNode Embedding 缓存
            let mut to_emb = None;
            if let Ok(existing) = graph_store.get_node(&to_id).await {
                if existing.embedding.is_some() {
                    to_emb = existing.embedding;
                }
            }
            if to_emb.is_none() {
                if let Ok(vec) = self.client.create_embedding(&to_node).await {
                    to_emb = Some(vec);
                }
            }

            let mut to_props = HashMap::new();
            to_props.insert("name".to_string(), serde_json::json!(to_node));

            let t_node = Node {
                id: to_id.clone(),
                label: to_type.clone(),
                properties: to_props,
                embedding: to_emb,
                is_permanent: false,
                last_accessed: Utc::now(),
            };
            if let Err(e) = graph_store.add_node(t_node).await {
                eprintln!("⚠️ [Curator] 写入节点 {} 失败: {:?}", to_id, e);
                continue;
            }

            // 写入 Edge
            let edge_id = format!("{}-{}-{}", from_id, to_id, relation.to_lowercase());
            let edge = Edge {
                id: edge_id.clone(),
                from_node: from_id.clone(),
                to_node: to_id.clone(),
                edge_type: relation.clone(),
                properties: HashMap::new(),
                weight: 1.0,
                is_permanent: false,
                last_accessed: Utc::now(),
            };
            if let Err(e) = graph_store.add_edge(edge).await {
                eprintln!("⚠️ [Curator] 写入边 {} 失败: {:?}", edge_id, e);
                continue;
            }

            println!(
                "💡 [Curator] 图谱新增关系: {} ({}) -[{}]-> {} ({})",
                from_node, from_type, relation, to_node, to_type
            );
        }

        Ok(())
    }

    async fn extract_relations(&self, text: &str) -> Result<Vec<ExtractedRelation>, Box<dyn std::error::Error + Send + Sync>> {
        let prompt = format!(
            r#"你是一个名为 Curator 的知识与经验提炼引擎。
分析以下用户与 AI 的最新对话（包含报错与成功自愈的过程），站在系统架构师的高维视角，提炼出其中的“概念原理”、“经验教训”、“故障问题”与“通用解法”。

严格遵循以下知识图谱 schema 规范：
1. 节点类型 (from_type / to_type) 必须是以下四者之一：
   - "Concept" (技术概念或底层原理，如: SQLite共享物理库, 协程逃逸)
   - "Issue" (开发中碰到的具体报错或死锁故障，如: 外键级联删除漏洞, 并发连接冲突锁死)
   - "Solution" (解决上述故障 of 通用方法，如: INSERT ON CONFLICT DO UPDATE, 限制连接数MaxOpenConns(1))
   - "Lesson" (总结出来的普适编码规约，如: 必须先关闭sql.Rows再申领连接)
2. 边关系 (relation) 必须是极简英文大写谓词：
   - "Causes" (故障诱发了另一故障，Issue ➔ Issue)
   - "Resolves" (解决方案解决了该故障，Solution ➔ Issue)
   - "AssociatedWith" (概念与概念、概念与经验之间的相关联)

【严禁规则】：不要提取诸如具体的文件路径、命令参数、修改的代码行数等 facts（运行日志细节）。我们只需要高抽象级别的经验和机制概念。

请严格以 JSON 数组格式返回提取结果，不要带 markdown 格式，不要有任何前缀或后缀。如果无法提取，请返回空数组。

示例格式：
[
  {{"from": "并发连接冲突锁死", "from_type": "Issue", "to": "限制连接数MaxOpenConns(1)", "to_type": "Solution", "relation": "Resolves"}},
  {{"from": "限制连接数MaxOpenConns(1)", "from_type": "Solution", "to": "SQLite共享物理库", "to_type": "Concept", "relation": "AssociatedWith"}}
]

待分析的对话时序：
{}"#,
            text
        );

        let resp = self.client.create_completion(
            vec![Message {
                role: "user".to_string(),
                content: prompt,
                name: None,
                tool_call_id: None,
                tool_calls: None,
            }],
            Vec::new(),
        ).await?;

        let mut clean_json = resp.content.trim();
        clean_json = clean_json.trim_start_matches("```json");
        clean_json = clean_json.trim_start_matches("```");
        clean_json = clean_json.trim_end_matches("```");
        let clean_json = clean_json.trim();

        if clean_json.is_empty() || clean_json == "[]" {
            return Ok(Vec::new());
        }

        let relations: Vec<ExtractedRelation> = serde_json::from_str(clean_json)?;
        Ok(relations)
    }

    fn get_graph_store(&self) -> Option<Arc<dyn GraphStore>> {
        self.graph_store.clone()
    }
}
