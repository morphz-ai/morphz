package orchestrator

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"morphz/event"
	"morphz/llm"
	"morphz/memory"
)

type Curator struct {
	store  memory.EventStore
	client llm.Client
}

func NewCurator(store memory.EventStore, client llm.Client) *Curator {
	return &Curator{
		store:  store,
		client: client,
	}
}

type ExtractedRelation struct {
	From     string `json:"from"`
	FromType string `json:"from_type"`
	To       string `json:"to"`
	ToType   string `json:"to_type"`
	Relation string `json:"relation"`
}

// ExtractAndStore 异步提取一轮对话的实体关系并写入 GraphStore
func (c *Curator) ExtractAndStore(ctx context.Context, sessionID string) {
	// 1. 从 EventStore 中查询当前 Session 的最近事件，构建对话片段
	filter := memory.QueryFilter{Topic: "chat/*"}
	events, err := c.store.Query(ctx, filter)
	if err != nil {
		fmt.Printf("⚠️  [Curator] 查询事件失败: %v\n", err)
		return
	}

	// 只保留当前 session 的最近 4 条消息（代表一到两轮完整交互）
	var sessionEvents []event.Event
	for _, ev := range events {
		sess, _ := ev.Payload["session_id"].(string)
		if sess == sessionID {
			sessionEvents = append(sessionEvents, ev)
		}
	}

	if len(sessionEvents) == 0 {
		return
	}

	if len(sessionEvents) > 4 {
		sessionEvents = sessionEvents[len(sessionEvents)-4:]
	}

	// 构建文本上下文
	var builder strings.Builder
	for _, ev := range sessionEvents {
		text, _ := ev.Payload["text"].(string)
		if text != "" {
			actor := ev.Actor
			if ev.Type == event.TypeUserMessage {
				actor = "User"
			}
			builder.WriteString(fmt.Sprintf("%s: %s\n", actor, text))
		}
	}

	conversationText := builder.String()
	if conversationText == "" {
		return
	}

	fmt.Println("🔍 [Curator] 启动异步知识提炼...")

	// 2. 调用 LLM 提炼实体关系
	relations, err := c.extractRelations(ctx, conversationText)
	if err != nil {
		fmt.Printf("⚠️  [Curator] LLM 知识提取失败: %v\n", err)
		return
	}

	if len(relations) == 0 {
		fmt.Println("🔍 [Curator] 本轮对话未提炼出新知识。")
		return
	}

	// 3. 将提炼的实体和关系落入 GraphStore
	graphStore, ok := c.store.(memory.GraphStore)
	if !ok {
		fmt.Println("⚠️  [Curator] store 未实现 GraphStore 接口，跳过图谱写入")
		return
	}

	for _, rel := range relations {
		fromNode := strings.TrimSpace(rel.From)
		toNode := strings.TrimSpace(rel.To)
		relation := strings.ToUpper(strings.TrimSpace(rel.Relation))

		fromType := strings.TrimSpace(rel.FromType)
		if fromType == "" {
			fromType = "Concept"
		}
		toType := strings.TrimSpace(rel.ToType)
		if toType == "" {
			toType = "Concept"
		}

		if fromNode == "" || toNode == "" || relation == "" {
			continue
		}

		fromID := strings.ToLower(fromNode)
		toID := strings.ToLower(toNode)

		// 1. 获取/计算 fromNode Embedding 缓存
		var fromEmb []float32
		if existing, err := graphStore.GetNode(ctx, fromID); err == nil && len(existing.Embedding) > 0 {
			fromEmb = existing.Embedding
		} else {
			if vec, err := c.client.CreateEmbedding(ctx, fromNode); err == nil {
				fromEmb = vec
			}
		}

		// 写入 Node
		err = graphStore.AddNode(ctx, memory.Node{
			ID:           fromID,
			Label:        fromType,
			Properties:   map[string]interface{}{"name": fromNode},
			Embedding:    fromEmb,
			LastAccessed: time.Now().UTC(),
		})
		if err != nil {
			fmt.Printf("⚠️  [Curator] 写入节点失败: %v\n", err)
			continue
		}

		// 2. 获取/计算 toNode Embedding 缓存
		var toEmb []float32
		if existing, err := graphStore.GetNode(ctx, toID); err == nil && len(existing.Embedding) > 0 {
			toEmb = existing.Embedding
		} else {
			if vec, err := c.client.CreateEmbedding(ctx, toNode); err == nil {
				toEmb = vec
			}
		}

		err = graphStore.AddNode(ctx, memory.Node{
			ID:           toID,
			Label:        toType,
			Properties:   map[string]interface{}{"name": toNode},
			Embedding:    toEmb,
			LastAccessed: time.Now().UTC(),
		})
		if err != nil {
			fmt.Printf("⚠️  [Curator] 写入节点失败: %v\n", err)
			continue
		}

		// 写入 Edge
		edgeID := fmt.Sprintf("%s-%s-%s", fromID, toID, strings.ToLower(relation))
		err = graphStore.AddEdge(ctx, memory.Edge{
			ID:           edgeID,
			FromNode:     fromID,
			ToNode:       toID,
			Type:         relation,
			Weight:       1.0,
			Properties:   map[string]interface{}{},
			LastAccessed: time.Now().UTC(),
		})
		if err != nil {
			fmt.Printf("⚠️  [Curator] 写入边失败: %v\n", err)
			continue
		}

		fmt.Printf("💡 [Curator] 图谱新增关系: %s (%s) -[%s]-> %s (%s)\n", fromNode, fromType, relation, toNode, toType)
	}
}

func (c *Curator) extractRelations(ctx context.Context, text string) ([]ExtractedRelation, error) {
	prompt := `你是一个名为 Curator 的知识与经验提炼引擎。
分析以下用户与 AI 的最新对话（包含报错与成功自愈的过程），站在系统架构师的高维视角，提炼出其中的“概念原理”、“经验教训”、“故障问题”与“通用解法”。

严格遵循以下知识图谱 schema 规范：
1. 节点类型 (from_type / to_type) 必须是以下四者之一：
   - "Concept" (技术概念或底层原理，如: SQLite共享物理库, 协程逃逸)
   - "Issue" (开发中碰到的具体报错或死锁故障，如: 外键级联删除漏洞, 并发连接冲突锁死)
   - "Solution" (解决上述故障的通用方法，如: INSERT ON CONFLICT DO UPDATE, 限制连接数MaxOpenConns(1))
   - "Lesson" (总结出来的普适编码规约，如: 必须先关闭sql.Rows再申领连接)
2. 边关系 (relation) 必须是极简英文大写谓词：
   - "Causes" (故障诱发了另一故障，Issue ➔ Issue)
   - "Resolves" (解决方案解决了该故障，Solution ➔ Issue)
   - "AssociatedWith" (概念与概念、概念与经验之间的相关联)

【严禁规则】：不要提取诸如具体的文件路径、命令参数、修改的代码行数等 facts（运行日志细节）。我们只需要高抽象级别的经验和机制概念。

请严格以 JSON 数组格式返回提取结果，不要带 markdown 格式，不要有任何前缀或后缀。如果无法提取，请返回空数组。

示例格式：
[
  {"from": "并发连接冲突锁死", "from_type": "Issue", "to": "限制连接数MaxOpenConns(1)", "to_type": "Solution", "relation": "Resolves"},
  {"from": "限制连接数MaxOpenConns(1)", "from_type": "Solution", "to": "SQLite共享物理库", "to_type": "Concept", "relation": "AssociatedWith"}
]

待分析的对话时序：
` + text

	resp, err := c.client.CreateCompletion(ctx, []llm.Message{
		{Role: "user", Content: prompt},
	}, nil)
	if err != nil {
		return nil, err
	}

	cleanJSON := strings.TrimSpace(resp.Content)
	// 清理 markdown 代码块残留
	cleanJSON = strings.TrimPrefix(cleanJSON, "```json")
	cleanJSON = strings.TrimPrefix(cleanJSON, "```")
	cleanJSON = strings.TrimSuffix(cleanJSON, "```")
	cleanJSON = strings.TrimSpace(cleanJSON)

	if cleanJSON == "" || cleanJSON == "[]" {
		return nil, nil
	}

	var relations []ExtractedRelation
	if err := json.Unmarshal([]byte(cleanJSON), &relations); err != nil {
		return nil, fmt.Errorf("解析知识 JSON 失败: %w, 原文为: %s", err, cleanJSON)
	}

	return relations, nil
}
