package orchestrator

import (
	"context"
	"strings"
	"testing"

	"morphz/event"
	"morphz/llm"
	"morphz/memory"
)

func TestCurator_ExtractAndStore(t *testing.T) {
	// 1. 初始化 SQLite EventStore/GraphStore
	store, err := memory.NewSqliteStore(":memory:")
	if err != nil {
		t.Fatalf("Failed to initialize memory sqlite store: %v", err)
	}
	defer store.Close()

	// 2. 模拟对话历史落库
	ctx := context.Background()
	sessionID := "session_curator_test_123"

	// 第一条：User message
	ev1 := event.NewEvent("m1", "User", event.TypeUserMessage, "chat/user_message", map[string]interface{}{
		"session_id": sessionID,
		"text":       "我正在用 Go 开发一个叫做 Morphz 的智能体框架。",
	})
	_ = store.Append(ctx, ev1)

	// 第二条：Agent reply
	ev2 := event.NewEvent("m2", "Agent-Morphz", event.TypeAgentCall, "chat/reply", map[string]interface{}{
		"session_id": sessionID,
		"text":       "那真是太棒了！Morphz 项目一定会非常成功。",
	})
	_ = store.Append(ctx, ev2)

	// 3. Mock LLM 返回提取好的 JSON
	mockClient := &mockLLMClient{
		onCompletion: func(ctx context.Context, messages []llm.Message, tools []llm.ToolDefinition, callCount int) (llm.Response, error) {
			return llm.Response{
				Content: `[
					{"from": "SQLiteConcurrencyLock", "from_type": "Issue", "to": "SetMaxOpenConns(1)", "to_type": "Solution", "relation": "Resolves"},
					{"from": "SetMaxOpenConns(1)", "from_type": "Solution", "to": "SQLiteSharedMemory", "to_type": "Concept", "relation": "AssociatedWith"}
				]`,
			}, nil
		},
	}

	curator := NewCurator(store, mockClient)

	// 4. 调用 ExtractAndStore
	curator.ExtractAndStore(ctx, sessionID)

	// 5. 验证 Graph 数据库内容
	var graphStore memory.GraphStore = store

	// 查询 node "sqliteconcurrencylock"
	node1, err := graphStore.GetNode(ctx, "sqliteconcurrencylock")
	if err != nil {
		t.Fatalf("Failed to get node 'sqliteconcurrencylock': %v", err)
	}
	if node1.Label != "Issue" {
		t.Errorf("Expected node label 'Issue', got '%s'", node1.Label)
	}
	if len(node1.Embedding) == 0 {
		t.Errorf("Expected node 'sqliteconcurrencylock' to contain embedding vector, but it was empty")
	}

	// 查询 node "setmaxopenconns(1)"
	node2, err := graphStore.GetNode(ctx, "setmaxopenconns(1)")
	if err != nil {
		t.Fatalf("Failed to get node 'setmaxopenconns(1)': %v", err)
	}
	if node2.Label != "Solution" {
		t.Errorf("Expected node label 'Solution', got '%s'", node2.Label)
	}
	if len(node2.Embedding) == 0 {
		t.Errorf("Expected node 'setmaxopenconns(1)' to contain embedding, but got empty")
	}

	// 验证 Edge "sqliteconcurrencylock-setmaxopenconns(1)-resolves"
	_, edges, err := graphStore.GetNeighbors(ctx, "sqliteconcurrencylock")
	if err != nil {
		t.Fatalf("Failed to query edges for sqliteconcurrencylock: %v", err)
	}

	foundResolves := false
	for _, edge := range edges {
		if edge.FromNode == "sqliteconcurrencylock" && edge.ToNode == "setmaxopenconns(1)" && strings.ToUpper(edge.Type) == "RESOLVES" {
			foundResolves = true
			break
		}
	}

	if !foundResolves {
		t.Errorf("Expected edge 'sqliteconcurrencylock -[RESOLVES]-> setmaxopenconns(1)' to be created, but it was not found. Actual edges: %+v", edges)
	}
}

func TestCurator_ExtractAndStore_Empty(t *testing.T) {
	store, _ := memory.NewSqliteStore(":memory:")
	defer store.Close()

	mockClient := &mockLLMClient{
		onCompletion: func(ctx context.Context, messages []llm.Message, tools []llm.ToolDefinition, callCount int) (llm.Response, error) {
			return llm.Response{
				Content: "[]",
			}, nil
		},
	}

	curator := NewCurator(store, mockClient)
	curator.ExtractAndStore(context.Background(), "session_empty")

	// 验证应该没有任何顶点写入
	// 我们可以查询随机 ID，应该返回 sql.ErrNoRows 报错
	var graphStore memory.GraphStore = store
	_, err := graphStore.GetNode(context.Background(), "any")
	if err == nil {
		t.Errorf("Expected error when fetching non-existing node")
	}
}
