use crate::event::{Event, InMemoryEventBus, TYPE_AGENT_CALL, TYPE_TOOL_OUTPUT, TYPE_USER_MESSAGE};
use crate::llm::{Client, Message};
use crate::memory::{EventStore, GraphStore, QueryFilter};
use crate::orchestrator::compressor::Compressor;
use crate::orchestrator::curator::Curator;
use crate::tool::Registry;
use chrono::Utc;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

pub struct Orchestrator {
    bus: Arc<InMemoryEventBus>,
    store: Arc<dyn EventStore>,
    graph_store: Option<Arc<dyn GraphStore>>,
    client: Arc<dyn Client>,
    registry: Arc<Registry>,
    compressor: Arc<Compressor>,
    curator: Arc<Curator>,
    pub concurrency_semaphore: Arc<tokio::sync::Semaphore>,
}

impl Orchestrator {
    pub fn new(
        bus: Arc<InMemoryEventBus>,
        store: Arc<dyn EventStore>,
        graph_store: Option<Arc<dyn GraphStore>>,
        client: Arc<dyn Client>,
        registry: Arc<Registry>,
    ) -> Self {
        let compressor = Arc::new(Compressor::new(2000, 10, Arc::clone(&client)));
        let curator = Arc::new(Curator::new(
            Arc::clone(&store),
            graph_store.clone(),
            Arc::clone(&client),
        ));
        let concurrency_semaphore = Arc::new(tokio::sync::Semaphore::new(4));

        Self {
            bus,
            store,
            graph_store,
            client,
            registry,
            compressor,
            curator,
            concurrency_semaphore,
        }
    }

    pub async fn start(self: Arc<Self>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // 1. 系统底层审计感知：自动拦截全局所有事件，归档至 WAL EventStore
        let store_clone = Arc::clone(&self.store);
        self.bus.subscribe(
            "*".to_string(),
            Arc::new(move |ev| {
                let s = Arc::clone(&store_clone);
                Box::pin(async move {
                    s.append(ev).await?;
                    Ok(())
                })
            }),
        );

        // 2. 注册核心 Agent 唤醒监听器
        let orchestrator = Arc::clone(&self);
        self.bus.subscribe(
            "chat/*".to_string(),
            Arc::new(move |ev| {
                let orc = Arc::clone(&orchestrator);
                Box::pin(async move {
                    orc.handle_chat_event(ev).await?;
                    Ok(())
                })
            }),
        );

        // 3. 注册并发子智能体 Spawning 派生监听器
        let orchestrator_spawn = Arc::clone(&self);
        self.bus.subscribe(
            "chat/spawn".to_string(),
            Arc::new(move |ev| {
                let orc = Arc::clone(&orchestrator_spawn);
                Box::pin(async move {
                    orc.handle_spawn_event(ev).await?;
                    Ok(())
                })
            }),
        );

        Ok(())
    }

    async fn handle_spawn_event(&self, ev: Event) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let sub_session_id = match ev.payload.get("session_id").and_then(|s| s.as_str()) {
            Some(s) => s.to_string(),
            None => return Ok(()),
        };
        let parent_session_id = match ev.payload.get("parent_session_id").and_then(|s| s.as_str()) {
            Some(s) => s.to_string(),
            None => return Ok(()),
        };
        let initial_context_str = match ev.payload.get("initial_context").and_then(|s| s.as_str()) {
            Some(s) => s.to_string(),
            None => return Ok(()),
        };

        // 1. 验证传入的 Lisp 心智状态 S-Expression 语法合法性
        if let Err(e) = crate::sexpr::parse(&initial_context_str) {
            return Err(format!("子智能体初始化 SExpr 语法错误: {}", e).into());
        }

        // 2. 向存储中追加 Proposal 事件，在 Fold 时初始化子会话的 Context 状态
        let instruction = format!("(begin (clear (context)) (set (context) {}))", initial_context_str);
        
        let mut prop_payload = serde_json::Map::new();
        prop_payload.insert("session_id".to_string(), serde_json::json!(sub_session_id));
        prop_payload.insert("parent_session_id".to_string(), serde_json::json!(parent_session_id));
        prop_payload.insert("instruction".to_string(), serde_json::json!(instruction));
        prop_payload.insert("text".to_string(), serde_json::json!(instruction));

        let prop_ev = Event::new(
            format!("sub_init_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)),
            "System-Spawner".to_string(),
            crate::event::TYPE_PROPOSAL.to_string(),
            "chat/context_proposal".to_string(),
            prop_payload,
        );
        self.store.append(prop_ev).await?;

        // 3. 在后台发布虚拟的 TYPE_USER_MESSAGE 启动事件，激活子会话推理
        let bus_clone = Arc::clone(&self.bus);
        tokio::spawn(async move {
            println!("🚀 [Sub-Agent Spawned] 开始运行。子会话 ID: {}, 父会话 ID: {}", sub_session_id, parent_session_id);
            
            let mut start_payload = serde_json::Map::new();
            start_payload.insert("session_id".to_string(), serde_json::json!(sub_session_id));
            start_payload.insert("parent_session_id".to_string(), serde_json::json!(parent_session_id));
            start_payload.insert("text".to_string(), serde_json::json!("Start executing task."));

            let start_ev = Event::new(
                format!("sub_start_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)),
                "System-Spawner".to_string(),
                TYPE_USER_MESSAGE.to_string(),
                "chat/user_message".to_string(),
                start_payload,
            );

            let _ = bus_clone.publish(start_ev).await;
        });

        Ok(())
    }

    async fn handle_chat_event(&self, ev: Event) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let session_id = match ev.payload.get("session_id").and_then(|s| s.as_str()) {
            Some(s) => s.to_string(),
            None => return Ok(()),
        };

        // 避免自我死循环：如果是最终答复 chat/reply，我们不重复唤醒 Agent，但触发记录提取
        if ev.event_type == TYPE_AGENT_CALL && ev.topic == "chat/reply" {
            let curator_clone = Arc::clone(&self.curator);
            curator_clone.extract_and_store(session_id.clone());

            // 如果有 parent_session_id，说明是子智能体运行结束，需要向父智能体发布 tool_output 以唤醒父智能体
            if let Some(parent_sess) = ev.payload.get("parent_session_id").and_then(|s| s.as_str()) {
                let reply_text = ev.payload.get("text").and_then(|s| s.as_str()).unwrap_or("");
                let mut wakeup_payload = serde_json::Map::new();
                wakeup_payload.insert("session_id".to_string(), serde_json::json!(parent_sess));
                wakeup_payload.insert("text".to_string(), serde_json::json!(format!("子智能体 {} 执行完毕，最终答复: {}", session_id, reply_text)));

                let wakeup_ev = Event::new(
                    format!("wakeup_{}_{}", parent_sess, Utc::now().timestamp_nanos_opt().unwrap_or(0)),
                    format!("Sub-Agent-{}", session_id),
                    TYPE_TOOL_OUTPUT.to_string(),
                    "chat/tool_output".to_string(),
                    wakeup_payload,
                );
                
                let bus_clone = Arc::clone(&self.bus);
                tokio::spawn(async move {
                    let _ = bus_clone.publish(wakeup_ev).await;
                });
            }
            return Ok(());
        }

        // 仅在收到用户输入 (user_message) 或工具执行完毕 (tool_output) 时，才触发 Attempt 运行
        if ev.event_type != TYPE_USER_MESSAGE && ev.event_type != TYPE_TOOL_OUTPUT {
            return Ok(())
        }

        println!("\n🤖 [Agent 唤醒] 触发事件: {} (Actor: {}, Type: {})", ev.topic, ev.actor, ev.event_type);
        println!("[Agent 思考中...] 正在进行 S-Expression Context 折叠与状态求值...");

        // 2.1 动态 Context 求值 (Fold 计算)：基于快照与增量折叠，求值出当前的 SExpr 状态
        let mut start_time = None;
        let mut last_snapshot_id = None;
        let mut context_state = if let Some((snap_step, snap_data, snap_id, snap_time)) = self.store.get_latest_snapshot(&session_id).await? {
            start_time = chrono::DateTime::parse_from_rfc3339(&snap_time)
                .map(|dt| dt.with_timezone(&Utc))
                .ok();
            last_snapshot_id = Some(snap_id);
            println!("💾 [Snapshot] 命中历史快照 (Step {}), 开启增量折叠重放...", snap_step);
            crate::sexpr::parse(&snap_data).unwrap()
        } else {
            let initial_context_str = format!(
                r#"(context (metadata (session "{}") (step 0)) (history (summary "") (turns)) (variables) (todo_stack) (graph_anchors))"#,
                session_id
            );
            crate::sexpr::parse(&initial_context_str).unwrap()
        };

        let filter = QueryFilter {
            topic: Some("chat/*".to_string()),
            start_time,
            ..Default::default()
        };

        let mut events = self.store.query(filter).await?;

        // 增量去重：如果存在快照，只保留快照之后的事件
        if let Some(ref last_id) = last_snapshot_id {
            if let Some(pos) = events.iter().position(|e| &e.id == last_id) {
                events = events.split_off(pos + 1);
            }
        }

        for e in &events {
            let sess = match e.payload.get("session_id").and_then(|s| s.as_str()) {
                Some(s) => s,
                None => continue,
            };
            if sess != session_id {
                continue;
            }

            let text = e.payload.get("text").and_then(|s| s.as_str()).unwrap_or("");

            if e.event_type == TYPE_USER_MESSAGE {
                // 1. step 计数递增
                let step_num = match context_state.get_path(&["metadata", "step"]) {
                    Some(crate::sexpr::SExpr::Atom(s)) => s.parse::<i32>().unwrap_or(0),
                    _ => 0,
                };
                let next_step = step_num + 1;
                let _ = context_state.set_path(&["metadata", "step"], crate::sexpr::SExpr::Atom(next_step.to_string()));

                // 2. 构造并追加新的 turn 到 (history turns)
                let turn_str = format!(
                    r#"(turn (step {}) (user "{}") (assistant "pending"))"#,
                    next_step,
                    text.replace('\\', "\\\\").replace('"', "\\\"")
                );
                if let Ok(turn_sexpr) = crate::sexpr::parse(&turn_str) {
                    let turns_path = &["history", "turns"];
                    if let Some(crate::sexpr::SExpr::List(ref mut turns_list)) = context_state.get_path_mut(turns_path) {
                        turns_list.push(turn_sexpr);
                        // 维持最近 4 轮 Turns 细节，多余的在 Fold 过程中自动裁剪（首个元素是标识符 turns）
                        if turns_list.len() > 5 {
                            turns_list.remove(1);
                        }
                    } else {
                        let _ = context_state.set_path(turns_path, crate::sexpr::SExpr::List(vec![
                            crate::sexpr::SExpr::Atom("turns".to_string()),
                            turn_sexpr
                        ]));
                    }
                }
            } else if e.event_type == TYPE_AGENT_CALL {
                // 如果这是由当前会话衍生出的子会话的 chat/reply，进行 Fold 认知投影合并
                if e.topic == "chat/reply" {
                    if let Some(parent_sess) = e.payload.get("parent_session_id").and_then(|s| s.as_str()) {
                        if parent_sess == session_id {
                            let sub_sess = match e.payload.get("session_id").and_then(|s| s.as_str()) {
                                Some(s) => s,
                                None => "",
                            };
                            let result_text = e.payload.get("text").and_then(|s| s.as_str()).unwrap_or("");

                            // 1. 将子会话的状态与结果投影到变量槽中
                            let _ = context_state.set_path(&["variables", &format!("{}_status", sub_sess)], crate::sexpr::SExpr::Atom("completed".to_string()));
                            let _ = context_state.set_path(&["variables", &format!("{}_result", sub_sess)], crate::sexpr::SExpr::Atom(result_text.to_string()));

                            // 2. 自动在大脑 todo_stack 中将对应的 spawn 任务子节点移除，完成 Barrier 协同
                            if let Some(crate::sexpr::SExpr::List(ref mut todo_list)) = context_state.get_path_mut(&["todo_stack"]) {
                                let mut remove_idx = None;
                                for (idx, item) in todo_list.iter().enumerate().skip(1) {
                                    if let crate::sexpr::SExpr::List(kv) = item {
                                        if let Some(crate::sexpr::SExpr::Atom(k)) = kv.first() {
                                            if k == "spawn" {
                                                let mut matches = false;
                                                for inner in kv.iter().skip(1) {
                                                    if let crate::sexpr::SExpr::List(inner_kv) = inner {
                                                        if let Some(crate::sexpr::SExpr::Atom(inner_k)) = inner_kv.first() {
                                                            if inner_k == "sub_session" && inner_kv.len() == 2 {
                                                                if let Some(crate::sexpr::SExpr::Atom(sub_val)) = inner_kv.get(1) {
                                                                    if sub_val == sub_sess {
                                                                        matches = true;
                                                                        break;
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                                if matches {
                                                    remove_idx = Some(idx);
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                }
                                if let Some(r_idx) = remove_idx {
                                    todo_list.remove(r_idx);
                                }
                            }
                        }
                    }
                }

                // 将最新 turn 的 assistant "pending" 覆盖为实际大模型答复
                let turns_path = &["history", "turns"];
                if let Some(crate::sexpr::SExpr::List(ref mut turns_list)) = context_state.get_path_mut(turns_path) {
                    if turns_list.len() > 1 {
                        if let Some(crate::sexpr::SExpr::List(ref mut last_turn)) = turns_list.last_mut() {
                            let mut assistant_idx = None;
                            for (idx, item) in last_turn.iter().enumerate().skip(1) {
                                if let crate::sexpr::SExpr::List(kv) = item {
                                    if let Some(crate::sexpr::SExpr::Atom(k)) = kv.first() {
                                        if k == "assistant" {
                                            assistant_idx = Some(idx);
                                            break;
                                        }
                                    }
                                }
                            }
                            if let Some(a_idx) = assistant_idx {
                                let display_text = if text.is_empty() {
                                    if e.payload.get("tool_calls").is_some() {
                                        "[决定调用外部工具]"
                                    } else {
                                        "..."
                                    }
                                } else {
                                    text
                                };
                                last_turn[a_idx] = crate::sexpr::SExpr::List(vec![
                                    crate::sexpr::SExpr::Atom("assistant".to_string()),
                                    crate::sexpr::SExpr::Atom(display_text.to_string()),
                                ]);
                            }
                        }
                    }
                }
            } else if e.event_type == crate::event::TYPE_PROPOSAL {
                // 大模型调用的 eval_context 演算提案事件，直接在虚拟机中运行求值
                if let Some(inst_str) = e.payload.get("instruction").and_then(|s| s.as_str()) {
                    if let Ok(inst_sexpr) = crate::sexpr::parse(inst_str) {
                        if let Err(err) = crate::orchestrator::evaluator::eval_instruction(&mut context_state, &inst_sexpr) {
                            eprintln!("⚠️ [SExpr Eval Error] 演算执行失败: {}, 指令内容: {}", err, inst_str);
                        }
                    }
                }
            } else if e.event_type == TYPE_TOOL_OUTPUT {
                // 压缩大体积工具输出，并更新执行状态
                let compressed_text = self.compressor.compress_tool_output(text);
                let _ = context_state.set_path(&["variables", "last_tool_status"], crate::sexpr::SExpr::Atom("success".to_string()));

                // 将工具输出结果写入 turns 中
                let turns_path = &["history", "turns"];
                if let Some(crate::sexpr::SExpr::List(ref mut turns_list)) = context_state.get_path_mut(turns_path) {
                    if turns_list.len() > 1 {
                        if let Some(crate::sexpr::SExpr::List(ref mut last_turn)) = turns_list.last_mut() {
                            last_turn.push(crate::sexpr::SExpr::List(vec![
                                crate::sexpr::SExpr::Atom("tool_output".to_string()),
                                crate::sexpr::SExpr::Atom(compressed_text),
                            ]));
                        }
                    }
                }
            }
        }

        // 如果有新事件被折叠，且 step 达到 10 的倍数，在 tokio 异步线程中保存快照
        if !events.is_empty() {
            let current_step = match context_state.get_path(&["metadata", "step"]) {
                Some(crate::sexpr::SExpr::Atom(s)) => s.parse::<i32>().unwrap_or(0),
                _ => 0,
            };
            if current_step > 0 && current_step % 10 == 0 {
                if let Some(last_ev) = events.last() {
                    let store = Arc::clone(&self.store);
                    let session_id_clone = session_id.clone();
                    let snapshot_data = context_state.to_string();
                    let last_event_id = last_ev.id.clone();
                    let last_event_time = last_ev.timestamp.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
                    
                    tokio::spawn(async move {
                        if let Err(e) = store.save_snapshot(&session_id_clone, current_step, &snapshot_data, &last_event_id, &last_event_time).await {
                            eprintln!("⚠️ [Snapshot] 保存快照失败: {}", e);
                        } else {
                            println!("💾 [Snapshot] 成功保存 Session {} Step {} 的快照", session_id_clone, current_step);
                        }
                    });
                }
            }
        }

        // 2.2 三层记忆融合检索 (L1 EventHistory + L2 GraphMemory -> L3 Context)
        let mut last_user_text = None;
        if let Some(crate::sexpr::SExpr::List(turns_list)) = context_state.get_path(&["history", "turns"]) {
            if turns_list.len() > 1 {
                if let Some(crate::sexpr::SExpr::List(last_turn)) = turns_list.last() {
                    for item in last_turn {
                        if let crate::sexpr::SExpr::List(kv) = item {
                            if let Some(crate::sexpr::SExpr::Atom(k)) = kv.first() {
                                if k == "user" && kv.len() == 2 {
                                    if let Some(crate::sexpr::SExpr::Atom(u_text)) = kv.get(1) {
                                        last_user_text = Some(u_text.clone());
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        if let Some(user_text) = last_user_text {
            if let Some(ref graph_store) = self.graph_store {
                let mut anchors = Vec::new();
                let mut anchor_map = HashMap::new();

                // 1. 语义向量检索定位锚点
                let mut query_embedding = Vec::new();
                if let Ok(vec) = self.client.create_embedding(&user_text).await {
                    query_embedding = vec;
                }

                if !query_embedding.is_empty() {
                    if let Ok(nodes) = graph_store.search_nodes_by_embedding(&query_embedding, 5).await {
                        for node in nodes {
                            if !anchor_map.contains_key(&node.id) {
                                anchor_map.insert(node.id.clone(), true);
                                anchors.push(node);
                            }
                        }
                    }
                }

                // 2. 混合搜索
                if let Ok(matched_nodes) = graph_store.search_nodes_by_text(&user_text).await {
                    for node in matched_nodes {
                        if !anchor_map.contains_key(&node.id) {
                            anchor_map.insert(node.id.clone(), true);
                            anchors.push(node);
                        }
                    }
                }

                // 3. 语义空间跃迁
                let mut transitional_anchors = Vec::new();
                let mut transition_paths = Vec::new();

                for node in &anchors {
                    if let Some(ref emb) = node.embedding {
                        if let Ok(candidates) = graph_store.search_nodes_by_embedding(emb, 3).await {
                            for cand in candidates {
                                if cand.id == node.id || anchor_map.contains_key(&cand.id) {
                                    continue;
                                }
                                if let Some(ref cand_emb) = cand.embedding {
                                    let sim = local_cosine_similarity(emb, cand_emb);
                                    let threshold = if emb.len() == 256 { 0.55 } else { 0.85 };
                                    if sim >= threshold {
                                        transitional_anchors.push(cand.clone());
                                        transition_paths.push(json!({
                                            "from": node.id,
                                            "to": cand.id
                                        }));
                                    }
                                }
                            }
                        }
                    }
                }

                for node in transitional_anchors {
                    if !anchor_map.contains_key(&node.id) {
                        anchor_map.insert(node.id.clone(), true);
                        anchors.push(node);
                    }
                }

                // 4. 拓扑漫游扩散
                let mut walked_edges = Vec::new();
                let mut neighbor_nodes = Vec::new();
                let mut neighbor_map = HashMap::new();
                let mut edge_map = HashMap::new();

                if !anchors.is_empty() {
                    let mut mem_stories = Vec::new();
                    let mut story_map = HashMap::new();

                    for node in &anchors {
                        if let Ok((neighbors, edges)) = graph_store.get_neighbors(&node.id).await {
                            let mut node_map = HashMap::new();
                            node_map.insert(node.id.clone(), node.clone());
                            for n in neighbors {
                                node_map.insert(n.id.clone(), n.clone());
                                if !anchor_map.contains_key(&n.id) && !neighbor_map.contains_key(&n.id) {
                                    neighbor_map.insert(n.id.clone(), true);
                                    neighbor_nodes.push(n);
                                }
                            }

                            for edge in edges {
                                if !edge_map.contains_key(&edge.id) {
                                    edge_map.insert(edge.id.clone(), true);
                                    walked_edges.push(edge.clone());
                                }

                                let mut from_node = node_map.get(&edge.from_node).cloned();
                                let mut to_node = node_map.get(&edge.to_node).cloned();

                                if from_node.is_none() {
                                    if let Ok(n) = graph_store.get_node(&edge.from_node).await {
                                        from_node = Some(n);
                                    }
                                }
                                if to_node.is_none() {
                                    if let Ok(n) = graph_store.get_node(&edge.to_node).await {
                                        to_node = Some(n);
                                    }
                                }

                                let mut from_name = edge.from_node.clone();
                                if let Some(ref fn_node) = from_node {
                                    if let Some(name_val) = fn_node.properties.get("name").and_then(|v| v.as_str()) {
                                        from_name = name_val.to_string();
                                    }
                                    from_name = format!("[{}] {}", fn_node.label, from_name);
                                }

                                let mut to_name = edge.to_node.clone();
                                if let Some(ref tn_node) = to_node {
                                    if let Some(name_val) = tn_node.properties.get("name").and_then(|v| v.as_str()) {
                                        to_name = name_val.to_string();
                                    }
                                    to_name = format!("[{}] {}", tn_node.label, to_name);
                                }

                                let story = format!("- {} -[{}]-> {}", from_name, edge.edge_type, to_name);
                                if !story_map.contains_key(&story) {
                                    story_map.insert(story.clone(), true);
                                    mem_stories.push(story);
                                }
                            }
                        }
                    }

                    // 发布内存漫游事件，同步大盘
                    let walk_ev = Event::new(
                        format!("walk_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)),
                        "System-MemoryWalker".to_string(),
                        crate::event::TYPE_PROPOSAL.to_string(),
                        "chat/memory_walk".to_string(),
                        vec![
                            ("session_id".to_string(), json!(session_id)),
                            ("anchors".to_string(), json!(anchors)),
                            ("transition_paths".to_string(), json!(transition_paths)),
                            ("neighbor_nodes".to_string(), json!(neighbor_nodes)),
                            ("walked_edges".to_string(), json!(walked_edges)),
                        ]
                        .into_iter()
                        .collect(),
                    );
                    let _ = self.bus.publish(walk_ev).await;

                    // 长期记忆以只读方式，动态注入 graph_anchors 槽位
                    if !mem_stories.is_empty() {
                        let mut anchor_sexprs = vec![crate::sexpr::SExpr::Atom("graph_anchors".to_string())];
                        for story in mem_stories {
                            anchor_sexprs.push(crate::sexpr::SExpr::Atom(story));
                        }
                        let _ = context_state.set_path(&["graph_anchors"], crate::sexpr::SExpr::List(anchor_sexprs));
                        println!("💡 [三层记忆融合] 成功向 SExpr 状态机注入关联图谱记忆。");
                    }
                }
            }
        }

        // 打印记忆视口日志
        println!("--- 动态求值 Context SExpr 状态开始 ---");
        println!("{}", context_state.to_string());
        println!("--- 动态求值 Context SExpr 状态结束 ---");

        // 将 SExpr 消息序列转换为 JSON 消息，供大盘前端实时同步 L3 Context 视口
        // 大盘前端通常需要 JSON 格式
        let context_ev = Event::new(
            format!("context_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)),
            "System-ContextEvaluator".to_string(),
            crate::event::TYPE_PROPOSAL.to_string(),
            "chat/context_inspect".to_string(),
            vec![
                ("session_id".to_string(), json!(session_id)),
                ("text".to_string(), json!(context_state.to_string())),
            ]
            .into_iter()
            .collect(),
        );
        let _ = self.bus.publish(context_ev).await;

        // 2.2 大模型提问改版：冷热双轨 Prefix Cache 前缀缓存黄金排布
        let system_prompt = r#"你是一个名为 Morphz 的 AI 助理。
你运行在一个符号化 S-Expression (Yao-lang 格式) 状态机之上。
你当前完整的大脑心智状态 (Context) 会被拆分为相对静轨（Memory 长期记忆召回）与动态热轨（当前运行状态）两条消息作为输入发送给你。
你必须根据当前状态执行决策。如果你需要修改你的临时变量、任务规划栈 (todo_stack) 或者总结与剪裁对话历史 (history)，你必须调用 eval 工具，传入合法的 begin/set/push/pop/clear 演算指令来维护你自己的大脑状态。
注意：
1. 你的大脑状态 Context 结构如下：
   (context
     (metadata (session "...") (step X) (parent_session "..."))
     (history (summary "...") (turns (turn (step X) (user "...") (assistant "..."))))
     (variables ...)
     (todo_stack ...)
     (graph_anchors ...)
   )
2. (metadata) 节点是只读的，你任何试图修改它的指令都会被安全虚拟机拦截并报错。
3. 你的演算指令语法示例：
   - (set (variables key) value)
   - (push (todo_stack) (task "具体任务内容"))
   - (pop (todo_stack))
   - (clear (history turns)) : 建议在 turns 较长时调用此指令，并将核心经验总结到 (history summary) 中。
4. 你只拥有以下 5 个基础原子原语工具，严禁假想其他任何特化工具：
   - read: 读取指定文件文本。
   - write: 写入指定文件文本。
   - eval: 状态机心智自省演算更新。
   - exec: 在隔离沙箱中执行 Shell 命令。默认同步等待 1 秒，若超时会自动转入后台异步托管运行而不会被杀死。可以通过 wait_ms 参数自定义等待时长。
   - spawn: 派生并发子智能体去解决子任务（需要生成唯一的 sub_session_id 并设定 initial_context）。
请保持简明扼要的回答。"#;

        // 绝对静轨
        let mut messages = vec![
            Message {
                role: "system".to_string(),
                content: system_prompt.to_string(),
                name: None,
                tool_call_id: None,
                tool_calls: None,
            }
        ];

        // 相对静轨：图谱动态召回 memory/skill anchors
        let graph_anchors_str = if let Some(anchors) = context_state.get_path(&["graph_anchors"]) {
            anchors.to_string()
        } else {
            "(graph_anchors)".to_string()
        };

        // 动态热轨：高频变动的大脑心智状态
        let metadata_str = context_state.get_path(&["metadata"]).map(|s| s.to_string()).unwrap_or_default();
        let history_str = context_state.get_path(&["history"]).map(|s| s.to_string()).unwrap_or_default();
        let variables_str = context_state.get_path(&["variables"]).map(|s| s.to_string()).unwrap_or_default();
        let todo_stack_str = context_state.get_path(&["todo_stack"]).map(|s| s.to_string()).unwrap_or_default();
        let hot_context_str = format!(
            "(context\n  {}\n  {}\n  {}\n  {}\n)",
            metadata_str,
            history_str,
            variables_str,
            todo_stack_str
        );

        // 合并为一个单一的 user 消息，防止部分严格的大模型接口（如 Gemini、Anthropic/Claude）
        // 因连续发送相同 role (user) 消息而报错 (Alternating Roles 校验)
        let combined_user_content = format!("{}\n\n{}", graph_anchors_str, hot_context_str);

        messages.push(Message {
            role: "user".to_string(),
            content: combined_user_content,
            name: None,
            tool_call_id: None,
            tool_calls: None,
        });

        // 统计当前轮次中连续调用 eval 的次数，防止 LLM 在状态机中陷入无限自振荡死循环
        let mut eval_context_count = 0;
        for e in events.iter().rev() {
            if e.event_type == TYPE_USER_MESSAGE {
                break;
            }
            if e.event_type == TYPE_TOOL_OUTPUT {
                if let Some(t_name) = e.payload.get("tool_name").and_then(|s| s.as_str()) {
                    if t_name == "eval" {
                        eval_context_count += 1;
                    }
                }
            }
        }

        let mut tool_definitions = self.registry.definitions();
        if eval_context_count >= 2 {
            println!("⚠️ [防死循环保护] 检测到当前轮次已连续调用 eval {} 次，临时屏蔽该工具以强制模型收敛并输出最终答复。", eval_context_count);
            tool_definitions.retain(|def| def.name != "eval");
        }

        // 获取全局大模型并发推理锁（信号量），防止高并发 Spawning 时把 API 额度刷爆
        let _permit = self.concurrency_semaphore.acquire().await?;

        // 调用大模型客户端，注入工具定义
        println!("🧠 [LLM 推理中...] 发送请求 (并发锁已取得)...");
        let resp = self.client.create_completion(messages, tool_definitions).await?;

        // 2.3 关键分流决策：若大模型要求调用工具
        if !resp.tool_calls.is_empty() {
            println!("🧠 [Agent 决策] 决定调用 {} 个工具，开始执行...", resp.tool_calls.len());

            let mapped_tool_calls: Vec<crate::llm::ToolCall> = resp
                .tool_calls
                .iter()
                .map(|tc| crate::llm::ToolCall {
                    id: tc.id.clone(),
                    r#type: tc.r#type.clone(),
                    function: crate::llm::FunctionCall {
                        name: tc.func_name.clone(),
                        arguments: tc.arguments.clone(),
                    },
                })
                .collect();

            // 发布助手调用意图事件，归档保持时序
            let assistant_ev = Event::new(
                format!("call_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)),
                "Agent-Morphz".to_string(),
                TYPE_AGENT_CALL.to_string(),
                "chat/assistant_call".to_string(),
                vec![
                    ("session_id".to_string(), json!(session_id)),
                    ("text".to_string(), json!(resp.content)),
                    ("tool_calls".to_string(), json!(mapped_tool_calls)),
                ]
                .into_iter()
                .collect(),
            );
            let _ = self.bus.publish(assistant_ev).await;

            // 并发执行每个工具，并发布反馈事件
            let mut tasks = Vec::new();
            for tc in resp.tool_calls {
                let registry = Arc::clone(&self.registry);
                let bus = Arc::clone(&self.bus);
                let sess_id = session_id.clone();
                tasks.push(tokio::spawn(async move {
                    crate::tool::CURRENT_SESSION_ID.scope(sess_id.clone(), async move {
                        println!("🛠️  [工具开始] 名称: {}, 参数: {}", tc.func_name, tc.arguments);

                        // 配置 30 秒超时
                        let result = tokio::time::timeout(
                            tokio::time::Duration::from_secs(30),
                            async {
                                match registry.get(&tc.func_name) {
                                    Some(tool) => tool.execute(&tc.arguments).await,
                                    None => Err(format!("未注册的工具: {}", tc.func_name).into()),
                                }
                            }
                        ).await;

                        let output = match result {
                            Ok(Ok(out)) => {
                                println!("✅  [工具执行成功] 反馈: {}", out);
                                out
                            }
                            Ok(Err(e)) => {
                                let err_msg = format!("执行失败: {:?}", e);
                                println!("❌  [工具执行报错] {:?}", e);
                                err_msg
                            }
                            Err(_) => {
                                let err_msg = "执行超时: 超过了 30 秒限额".to_string();
                                println!("❌  [工具执行超时]");
                                err_msg
                            }
                        };

                        let tool_output_ev = Event::new(
                            format!("output_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)),
                            "System-Executor".to_string(),
                            TYPE_TOOL_OUTPUT.to_string(),
                            "chat/tool_output".to_string(),
                            vec![
                                ("session_id".to_string(), json!(sess_id)),
                                ("tool_call_id".to_string(), json!(tc.id)),
                                ("tool_name".to_string(), json!(tc.func_name)),
                                ("text".to_string(), json!(output)),
                            ]
                            .into_iter()
                            .collect(),
                        );
                        let _ = bus.publish(tool_output_ev).await;
                    }).await;
                }));
            }

            for task in tasks {
                let _ = task.await;
            }

            return Ok(());
        }

        // 2.4 若没有工具调用，说明问题完成，输出最终答复
        println!("🧠 [Agent 推理响应] -> 最终答案: {:?}", resp.content);

        let mut reply_payload = vec![
            ("session_id".to_string(), json!(session_id)),
            ("text".to_string(), json!(resp.content)),
        ];

        if let Some(crate::sexpr::SExpr::Atom(p_sess)) = context_state.get_path(&["metadata", "parent_session"]) {
            reply_payload.push(("parent_session_id".to_string(), json!(p_sess)));
        }

        let reply_ev = Event::new(
            format!("reply_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)),
            "Agent-Morphz".to_string(),
            TYPE_AGENT_CALL.to_string(),
            "chat/reply".to_string(),
            reply_payload.into_iter().collect(),
        );

        self.bus.publish(reply_ev).await?;
        Ok(())
    }
}

fn local_cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut norm_a = 0.0;
    let mut norm_b = 0.0;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        norm_a += a[i] * a[i];
        norm_b += b[i] * b[i];
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a.sqrt() * norm_b.sqrt())
}
