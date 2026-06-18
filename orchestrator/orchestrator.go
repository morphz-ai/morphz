package orchestrator

import (
	"context"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"morphz/event"
	"morphz/llm"
	"morphz/memory"
	"morphz/tool"
)

// Orchestrator 负责协调事件流转、Context 评估、LLM 推理决策与工具执行
type Orchestrator struct {
	bus        event.Bus
	store      memory.EventStore
	client     llm.Client
	registry   *tool.Registry
	compressor *Compressor
	curator    *Curator
}

// NewOrchestrator 构造函数，利用依赖注入实现完美解耦
func NewOrchestrator(bus event.Bus, store memory.EventStore, client llm.Client, registry *tool.Registry) *Orchestrator {
	// 默认限额：大工具输出最大 2000 字节，消息总数最大 10 条（防止上下文溢出）
	comp := NewCompressor(2000, 10, client)
	cur := NewCurator(store, client)
	return &Orchestrator{
		bus:        bus,
		store:      store,
		client:     client,
		registry:   registry,
		compressor: comp,
		curator:    cur,
	}
}

// Start 启动协调总线监听，开始运行 Agent 自驱引擎
func (o *Orchestrator) Start(ctx context.Context) error {
	// 1. 系统底层审计感知：自动拦截全局所有事件，归档至 WAL EventStore
	_, err := o.bus.Subscribe("*", func(ctx context.Context, ev event.Event) error {
		return o.store.Append(ctx, ev)
	})
	if err != nil {
		return fmt.Errorf("failed to register WAL archiver: %w", err)
	}

	// 2. 注册核心 Agent 唤醒监听器
	_, err = o.bus.Subscribe("chat/*", func(ctx context.Context, ev event.Event) error {
		// 避免自我死循环：如果是最终答复 chat/reply，我们不重复唤醒 Agent，但触发异步 Curator 知识提取
		if ev.Type == event.TypeAgentCall && ev.Topic == "chat/reply" {
			sessionID, _ := ev.Payload["session_id"].(string)
			if sessionID != "" {
				go o.curator.ExtractAndStore(ctx, sessionID)
			}
			return nil
		}

		// 仅在收到用户输入 (user_message) 或工具执行完毕 (tool_output) 时，才触发 Attempt 运行
		if ev.Type != event.TypeUserMessage && ev.Type != event.TypeToolOutput {
			return nil
		}

		sessionID, _ := ev.Payload["session_id"].(string)
		if sessionID == "" {
			return nil
		}

		fmt.Printf("\n🤖 [Agent 唤醒] 触发事件: %s (Actor: %s, Type: %s)\n", ev.Topic, ev.Actor, ev.Type)
		fmt.Println("[Agent 思考中...] 正在运行 Context 求值器折叠历史记录...")

		// 2.1 动态 Context 求值 (Fold 计算)：基于时序与 Session 进行隔离折叠
		filter := memory.QueryFilter{Topic: "chat/*"}
		initialMessages := []llm.Message{
			{
				Role:    "system",
				Content: "你是一个名为 Morphz 的下一代 AI 助理。请保持友好、简洁的回答。你可以调用本地的工具来读写文件完成任务。",
			},
		}

		result, err := o.store.Fold(ctx, filter, initialMessages, func(state interface{}, e event.Event) (interface{}, error) {
			msgs := state.([]llm.Message)

			// 隔离：只提取属于当前会话的事件
			sess, _ := e.Payload["session_id"].(string)
			if sess != sessionID {
				return msgs, nil
			}

			text, _ := e.Payload["text"].(string)

			// 2.1.1 映射 ToolOutput 消息
			if e.Type == event.TypeToolOutput {
				tcID, _ := e.Payload["tool_call_id"].(string)
				toolName, _ := e.Payload["tool_name"].(string)
				
				// 自动截断大体积工具输出
				compressedText := o.compressor.CompressToolOutput(text)
				
				msgs = append(msgs, llm.Message{
					Role:       "tool",
					Content:    compressedText,
					Name:       toolName,
					ToolCallID: tcID,
				})
				return msgs, nil
			}

			// 2.1.2 映射 AgentCall 消息 (包含普通的文本响应和携带 ToolCalls 动作的消息)
			if e.Type == event.TypeAgentCall {
				var tcs []llm.ToolCall
				if tcVal, ok := e.Payload["tool_calls"]; ok {
					if toolCalls, parsed := tcVal.([]llm.ToolCall); parsed {
						tcs = toolCalls
					}
				}
				msgs = append(msgs, llm.Message{
					Role:      "assistant",
					Content:   text,
					ToolCalls: tcs,
				})
				return msgs, nil
			}

			// 2.1.3 映射 User 消息
			if e.Type == event.TypeUserMessage {
				msgs = append(msgs, llm.Message{
					Role:    "user",
					Content: text,
				})
			}

			return msgs, nil
		})
		if err != nil {
			return fmt.Errorf("Context 求值计算失败: %w", err)
		}

		messages := result.([]llm.Message)

		// 2.2 三层记忆融合检索 (L1 EventHistory + L2 GraphMemory -> L3 Context)
		var lastUserText string
		for i := len(messages) - 1; i >= 0; i-- {
			if messages[i].Role == "user" {
				lastUserText = messages[i].Content
				break
			}
		}

		if lastUserText != "" {
			if graphStore, ok := o.store.(memory.GraphStore); ok {
				var anchors []memory.Node
				anchorMap := make(map[string]bool)

				// 1. 语义向量检索定位锚点
				var queryEmbedding []float32
				if vec, err := o.client.CreateEmbedding(ctx, lastUserText); err == nil {
					queryEmbedding = vec
				}

				if len(queryEmbedding) > 0 {
					// 向量召回 (topK = 5)
					if nodes, err := graphStore.SearchNodesByEmbedding(ctx, queryEmbedding, 5); err == nil {
						for _, node := range nodes {
							if !anchorMap[node.ID] {
								anchorMap[node.ID] = true
								anchors = append(anchors, node)
							}
						}
					}
				}

				// 2. 混合搜索：结合传统的子串文本模糊检索，增强确定性召回
				if matchedNodes, err := graphStore.SearchNodesByText(ctx, lastUserText); err == nil {
					for _, node := range matchedNodes {
						if !anchorMap[node.ID] {
							anchorMap[node.ID] = true
							anchors = append(anchors, node)
						}
					}
				}

				// 3. 语义空间跃迁 (直觉类比激活)：对定位的锚点，在向量空间中寻找没有直接相连但相似度极高的其他节点
				var transitionalAnchors []memory.Node
				type TransitionPath struct {
					From string `json:"from"`
					To   string `json:"to"`
				}
				var transitionPaths []TransitionPath

				for _, node := range anchors {
					if len(node.Embedding) > 0 {
						// 捞取与该锚点向量最接近的 3 个候选节点
						if candidates, err := graphStore.SearchNodesByEmbedding(ctx, node.Embedding, 3); err == nil {
							for _, cand := range candidates {
								if cand.ID == node.ID || anchorMap[cand.ID] {
									continue
								}
								// 计算其余弦相似度
								sim := localCosineSimilarity(node.Embedding, cand.Embedding)
								threshold := float32(0.85)
								if len(node.Embedding) == 256 {
									threshold = 0.55
								}
								if sim >= threshold {
									transitionalAnchors = append(transitionalAnchors, cand)
									transitionPaths = append(transitionPaths, TransitionPath{
										From: node.ID,
										To:   cand.ID,
									})
								}
							}
						}
					}
				}
				// 将跃迁激活的节点合并入锚点集合
				for _, node := range transitionalAnchors {
					if !anchorMap[node.ID] {
						anchorMap[node.ID] = true
						anchors = append(anchors, node)
					}
				}

				// 4. 拓扑漫游扩散：捞取以激活锚点为中心的一跳邻居，构建逻辑关系知识链
				var walkedEdges []memory.Edge
				var neighborNodes []memory.Node
				neighborMap := make(map[string]bool)
				edgeMap := make(map[string]bool)

				if len(anchors) > 0 {
					var memStories []string
					storyMap := make(map[string]bool)

					for _, node := range anchors {
						neighbors, edges, err := graphStore.GetNeighbors(ctx, node.ID)
						if err == nil {
							nodeMap := make(map[string]memory.Node)
							nodeMap[node.ID] = node
							for _, n := range neighbors {
								nodeMap[n.ID] = n
								if !anchorMap[n.ID] && !neighborMap[n.ID] {
									neighborMap[n.ID] = true
									neighborNodes = append(neighborNodes, n)
								}
							}

							for _, edge := range edges {
								if !edgeMap[edge.ID] {
									edgeMap[edge.ID] = true
									walkedEdges = append(walkedEdges, edge)
								}

								fromNode, fromExist := nodeMap[edge.FromNode]
								toNode, toExist := nodeMap[edge.ToNode]

								if !fromExist {
									if n, err := graphStore.GetNode(ctx, edge.FromNode); err == nil {
										fromNode = n
										fromExist = true
									}
								}
								if !toExist {
									if n, err := graphStore.GetNode(ctx, edge.ToNode); err == nil {
										toNode = n
										toExist = true
									}
								}

								fromName := edge.FromNode
								if fromExist {
									if nameVal, ok := fromNode.Properties["name"].(string); ok {
										fromName = nameVal
									}
									fromName = fmt.Sprintf("[%s] %s", fromNode.Label, fromName)
								}

								toName := edge.ToNode
								if toExist {
									if nameVal, ok := toNode.Properties["name"].(string); ok {
										toName = nameVal
									}
									toName = fmt.Sprintf("[%s] %s", toNode.Label, toName)
								}

								story := fmt.Sprintf("- %s -[%s]-> %s", fromName, edge.Type, toName)
								if !storyMap[story] {
									storyMap[story] = true
									memStories = append(memStories, story)
								}
							}
						}
					}

					// 发布内存漫游事件
					walkEv := event.NewEvent(
						fmt.Sprintf("walk_%d", time.Now().UnixNano()),
						"System-MemoryWalker",
						event.TypeProposal,
						"chat/memory_walk",
						map[string]interface{}{
							"session_id":      sessionID,
							"anchors":         anchors,
							"transition_paths": transitionPaths,
							"neighbor_nodes":  neighborNodes,
							"walked_edges":    walkedEdges,
						},
					)
					_ = o.bus.Publish(ctx, walkEv)

					// 如果有长期记忆关联，以系统背景消息形式注入 Context
					if len(memStories) > 0 {
						longTermMemoryMsg := llm.Message{
							Role:    "system",
							Content: fmt.Sprintf("你拥有以下与当前对话主题相关的长期记忆和背景知识，请合理参考它们来回答用户：\n%s", strings.Join(memStories, "\n")),
						}
						// 注入在系统全局 system prompt 的后方
						if len(messages) > 1 {
							messages = append(messages[:1], append([]llm.Message{longTermMemoryMsg}, messages[1:]...)...)
						} else {
							messages = append(messages, longTermMemoryMsg)
						}
						fmt.Printf("💡 [三层记忆融合] 成功注入 %d 条关联长期记忆\n", len(memStories))
					}
				}
			}
		}

		// 调用 Compressor 对历史消息序列进行动态总结压缩
		compressedMessages, err := o.compressor.CompressMessages(ctx, messages)
		if err == nil {
			messages = compressedMessages
		}

		// 打印记忆视口日志
		fmt.Println("--- 动态求值 Context 视口开始 ---")
		for _, msg := range messages {
			if msg.Role == "system" {
				continue
			}
			fmt.Printf("[%s] (大小: %d 字符)\n", strings.ToUpper(msg.Role), len(msg.Content))
		}
		fmt.Println("--- 动态求值 Context 视口结束 ---")

		// 发布系统 Context 监视事件，供大盘前端实时同步 L3 Context 视口
		contextEv := event.NewEvent(
			fmt.Sprintf("context_%d", time.Now().UnixNano()),
			"System-ContextEvaluator",
			event.TypeProposal,
			"chat/context_inspect",
			map[string]interface{}{
				"session_id": sessionID,
				"messages":   messages,
			},
		)
		_ = o.bus.Publish(ctx, contextEv)

		// 2.2 调用抽象的大模型客户端，注入工具定义
		fmt.Println("🧠 [LLM 推理中...] 发送请求...")
		resp, err := o.client.CreateCompletion(ctx, messages, o.registry.Definitions())
		if err != nil {
			return fmt.Errorf("LLM 推理失败: %w", err)
		}

		// 2.3 关键分流决策：若大模型要求调用工具
		if len(resp.ToolCalls) > 0 {
			fmt.Printf("🧠 [Agent 决策] 决定调用 %d 个工具，开始执行...\n", len(resp.ToolCalls))

			// 发布助手调用意图事件，归档至 Store 保持时序连贯
			assistantEv := event.NewEvent(
				fmt.Sprintf("call_%d", time.Now().UnixNano()),
				"Agent-Morphz",
				event.TypeAgentCall,
				"chat/assistant_call",
				map[string]interface{}{
					"session_id": sessionID,
					"text":       resp.Content,
					"tool_calls": resp.ToolCalls,
				},
			)
			_ = o.bus.Publish(ctx, assistantEv)

			// 并发执行每个工具，并发布反馈事件
			var wg sync.WaitGroup
			for _, tc := range resp.ToolCalls {
				wg.Add(1)
				go func(tc llm.ToolCall) {
					defer wg.Done()
					fmt.Printf("🛠️  [工具开始] 名称: %s, 参数: %s\n", tc.FuncName, tc.Arguments)

					// 为每个工具配置 30 秒执行超时控制
					toolCtx, toolCancel := context.WithTimeout(ctx, 30*time.Second)
					defer toolCancel()

					var output string
					var execErr error

					t, exists := o.registry.Get(tc.FuncName)
					if !exists {
						execErr = fmt.Errorf("未注册的工具: %s", tc.FuncName)
					} else {
						output, execErr = t.Execute(toolCtx, tc.Arguments)
					}

					if execErr != nil {
						output = fmt.Sprintf("执行失败: %v", execErr)
						fmt.Printf("❌  [工具执行报错] %v\n", execErr)
					} else {
						fmt.Printf("✅  [工具执行成功] 反馈: %s\n", output)
					}

					// 发布 ToolOutput 事件，自动触发总线机制唤醒下一轮 Attempt
					toolOutputEv := event.NewEvent(
						fmt.Sprintf("output_%d", time.Now().UnixNano()),
						"System-Executor",
						event.TypeToolOutput,
						"chat/tool_output",
						map[string]interface{}{
							"session_id":   sessionID,
							"tool_call_id": tc.ID,
							"tool_name":    tc.FuncName,
							"text":         output,
						},
					)
					_ = o.bus.Publish(ctx, toolOutputEv)
				}(tc)
			}
			wg.Wait()
			return nil
		}

		// 2.4 若没有工具调用，说明问题完成，输出最终答复
		fmt.Printf("🧠 [Agent 推理响应] -> 最终答案: %q\n\n", resp.Content)

		replyEv := event.NewEvent(
			fmt.Sprintf("reply_%d", time.Now().UnixNano()),
			"Agent-Morphz",
			event.TypeAgentCall,
			"chat/reply",
			map[string]interface{}{
				"session_id": sessionID,
				"text":       resp.Content,
			},
		)
		return o.bus.Publish(ctx, replyEv)
	})

	return err
}

func localCosineSimilarity(a, b []float32) float32 {
	if len(a) != len(b) || len(a) == 0 {
		return 0
	}
	var dotProduct, normA, normB float64
	for i := 0; i < len(a); i++ {
		dotProduct += float64(a[i] * b[i])
		normA += float64(a[i] * a[i])
		normB += float64(b[i] * b[i])
	}
	if normA == 0 || normB == 0 {
		return 0
	}
	return float32(dotProduct / (math.Sqrt(normA) * math.Sqrt(normB)))
}
