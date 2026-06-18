package orchestrator

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"morphz/event"
	"morphz/llm"
	"morphz/memory"
	"morphz/tool"
)

type mockLLMClient struct {
	mu           sync.Mutex
	callCount    int
	onCompletion func(ctx context.Context, messages []llm.Message, tools []llm.ToolDefinition, callCount int) (llm.Response, error)
}

func (m *mockLLMClient) CreateCompletion(ctx context.Context, messages []llm.Message, tools []llm.ToolDefinition) (llm.Response, error) {
	m.mu.Lock()
	m.callCount++
	count := m.callCount
	m.mu.Unlock()
	return m.onCompletion(ctx, messages, tools, count)
}

func (m *mockLLMClient) CreateEmbedding(ctx context.Context, text string) ([]float32, error) {
	// 简易 mock，返回基于字符长度生成的虚设向量以保持差异化
	val := float32(len(text)) * 0.01
	return []float32{val, val * 2, val * 3}, nil
}

type mockTool struct {
	name string
	fn   func(ctx context.Context, args string) (string, error)
}

func (t *mockTool) Name() string { return t.name }
func (t *mockTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        t.name,
		Description: "Mocked test tool",
		Parameters:  []byte(`{}`),
	}
}
func (t *mockTool) Execute(ctx context.Context, arguments string) (string, error) {
	return t.fn(ctx, arguments)
}

func TestOrchestrator_SelfCorrectionLoop_Success(t *testing.T) {
	bus := event.NewInMemoryEventBus()
	store := memory.NewInMemoryStore()
	registry := tool.NewRegistry()

	// 注册一个测试工具
	tTool := &mockTool{
		name: "test_tool",
		fn: func(ctx context.Context, args string) (string, error) {
			return "tool success result", nil
		},
	}
	_ = registry.Register(tTool)

	// mock LLM behavior
	var client mockLLMClient
	client.onCompletion = func(ctx context.Context, messages []llm.Message, tools []llm.ToolDefinition, callCount int) (llm.Response, error) {
		// 第一轮：要求调用工具
		if callCount == 1 {
			return llm.Response{
				Content: "Let me call test_tool",
				ToolCalls: []llm.ToolCall{
					{
						ID:        "call_123",
						Type:      "function",
						FuncName:  "test_tool",
						Arguments: "success",
					},
				},
			}, nil
		}
		// 第二轮：返回最终答案
		return llm.Response{
			Content: "Finished everything successfully!",
		}, nil
	}

	orc := NewOrchestrator(bus, store, &client, registry)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := orc.Start(ctx); err != nil {
		t.Fatalf("failed to start orchestrator: %v", err)
	}

	// 订阅 chat/reply 用来接收最终结果，验证流程是否完整跑通
	replyChan := make(chan event.Event, 1)
	sub, err := bus.Subscribe("chat/reply", func(ctx context.Context, ev event.Event) error {
		select {
		case replyChan <- ev:
		default:
		}
		return nil
	})
	if err != nil {
		t.Fatalf("failed to subscribe reply: %v", err)
	}
	defer sub.Unsubscribe()

	// 投递用户消息，触发自驱循环
	userEv := event.NewEvent(
		"user_trigger_1",
		"User",
		event.TypeUserMessage,
		"chat/user_message",
		map[string]interface{}{
			"session_id": "session_test_123",
			"text":       "Hello, please execute the tool.",
		},
	)

	// 使用 Publish 发布用户事件
	if err := bus.Publish(ctx, userEv); err != nil {
		t.Fatalf("failed to publish user message: %v", err)
	}

	// 等待最终答复，超时时间设为 2 秒
	select {
	case ev := <-replyChan:
		t.Logf("Received agent reply event: %+v", ev)
		text, _ := ev.Payload["text"].(string)
		if text != "Finished everything successfully!" {
			t.Errorf("expected final answer 'Finished everything successfully!', got '%s'", text)
		}
		sess, _ := ev.Payload["session_id"].(string)
		if sess != "session_test_123" {
			t.Errorf("expected session_id 'session_test_123', got '%s'", sess)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for agent reply, self correction loop failed")
	}

	// 检查存储中的事件，看看是否都被归档了
	events, err := store.Query(ctx, memory.QueryFilter{Topic: "chat/*"})
	if err != nil {
		t.Fatalf("failed to query events: %v", err)
	}

	if len(events) < 4 {
		t.Errorf("expected at least 4 recorded events, got %d", len(events))
	}
}

func TestOrchestrator_ToolFailure(t *testing.T) {
	bus := event.NewInMemoryEventBus()
	store := memory.NewInMemoryStore()
	registry := tool.NewRegistry()

	// 注册一个会失败的工具
	tTool := &mockTool{
		name: "fail_tool",
		fn: func(ctx context.Context, args string) (string, error) {
			return "", errors.New("simulated database failure")
		},
	}
	_ = registry.Register(tTool)

	var client mockLLMClient
	client.onCompletion = func(ctx context.Context, messages []llm.Message, tools []llm.ToolDefinition, callCount int) (llm.Response, error) {
		if callCount == 1 {
			return llm.Response{
				Content: "Attempting to query database",
				ToolCalls: []llm.ToolCall{
					{
						ID:        "call_fail",
						Type:      "function",
						FuncName:  "fail_tool",
						Arguments: "none",
					},
				},
			}, nil
		}
		// 校验是否收到了工具报错的输入
		lastMsg := messages[len(messages)-1]
		if lastMsg.Role == "tool" && lastMsg.Name == "fail_tool" {
			if lastMsg.Content == "执行失败: simulated database failure" {
				return llm.Response{
					Content: "I detected a failure in fail_tool, resolving gracefully.",
				}, nil
			}
		}
		return llm.Response{
			Content: "Unexpected flow.",
		}, nil
	}

	orc := NewOrchestrator(bus, store, &client, registry)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := orc.Start(ctx); err != nil {
		t.Fatalf("failed to start orchestrator: %v", err)
	}

	replyChan := make(chan event.Event, 1)
	sub, err := bus.Subscribe("chat/reply", func(ctx context.Context, ev event.Event) error {
		select {
		case replyChan <- ev:
		default:
		}
		return nil
	})
	if err != nil {
		t.Fatalf("failed to subscribe reply: %v", err)
	}
	defer sub.Unsubscribe()

	userEv := event.NewEvent(
		"user_trigger_2",
		"User",
		event.TypeUserMessage,
		"chat/user_message",
		map[string]interface{}{
			"session_id": "session_test_456",
			"text":       "Please run fail_tool.",
		},
	)

	if err := bus.Publish(ctx, userEv); err != nil {
		t.Fatalf("failed to publish user message: %v", err)
	}

	select {
	case ev := <-replyChan:
		text, _ := ev.Payload["text"].(string)
		if text != "I detected a failure in fail_tool, resolving gracefully." {
			t.Errorf("expected fail-grace answer, got '%s'", text)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for agent reply under tool failure scenario")
	}
}

func TestOrchestrator_ParallelTools(t *testing.T) {
	bus := event.NewInMemoryEventBus()
	store := memory.NewInMemoryStore()
	registry := tool.NewRegistry()

	// 注册两个慢工具，分别睡眠 200 毫秒
	t1 := &mockTool{
		name: "slow_tool_1",
		fn: func(ctx context.Context, args string) (string, error) {
			time.Sleep(200 * time.Millisecond)
			return "slow 1 done", nil
		},
	}
	t2 := &mockTool{
		name: "slow_tool_2",
		fn: func(ctx context.Context, args string) (string, error) {
			time.Sleep(200 * time.Millisecond)
			return "slow 2 done", nil
		},
	}
	_ = registry.Register(t1)
	_ = registry.Register(t2)

	var client mockLLMClient
	client.onCompletion = func(ctx context.Context, messages []llm.Message, tools []llm.ToolDefinition, callCount int) (llm.Response, error) {
		if callCount == 1 {
			// 一起调用两个工具
			return llm.Response{
				Content: "Run slow tools",
				ToolCalls: []llm.ToolCall{
					{ID: "call_1", Type: "function", FuncName: "slow_tool_1", Arguments: ""},
					{ID: "call_2", Type: "function", FuncName: "slow_tool_2", Arguments: ""},
				},
			}, nil
		}
		return llm.Response{
			Content: "Done!",
		}, nil
	}

	orc := NewOrchestrator(bus, store, &client, registry)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := orc.Start(ctx); err != nil {
		t.Fatalf("failed to start: %v", err)
	}

	replyChan := make(chan event.Event, 1)
	sub, err := bus.Subscribe("chat/reply", func(ctx context.Context, ev event.Event) error {
		select {
		case replyChan <- ev:
		default:
		}
		return nil
	})
	if err != nil {
		t.Fatalf("subscribe error: %v", err)
	}
	defer sub.Unsubscribe()

	userEv := event.NewEvent(
		"user_trigger_3",
		"User",
		event.TypeUserMessage,
		"chat/user_message",
		map[string]interface{}{
			"session_id": "session_parallel_test",
			"text":       "Run two tools",
		},
	)

	startTime := time.Now()
	if err := bus.Publish(ctx, userEv); err != nil {
		t.Fatalf("publish error: %v", err)
	}

	select {
	case <-replyChan:
		duration := time.Since(startTime)
		t.Logf("Execution finished in %v", duration)
		// 如果是串行，总执行时间至少是 200ms + 200ms = 400ms。
		// 并发执行的话，时间应该显著小于 400ms（一般在 200-300ms 之间）。
		if duration >= 380*time.Millisecond {
			t.Errorf("Expected tools to execute in parallel, but duration was %v (>= 380ms)", duration)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Timeout waiting for parallel tools reply")
	}
}

func TestOrchestrator_ThreeLayerMemory(t *testing.T) {
	bus := event.NewInMemoryEventBus()
	// 使用内存 SQLite 数据库支持 GraphStore 关联查询
	store, err := memory.NewSqliteStore(":memory:")
	if err != nil {
		t.Fatalf("Failed to init store: %v", err)
	}
	defer store.Close()

	registry := tool.NewRegistry()
	ctx := context.Background()

	// 1. 预先向图数据库写入关联长期记忆
	var graphStore memory.GraphStore = store
	_ = graphStore.AddNode(ctx, memory.Node{ID: "shafreeck", Label: "Entity", Properties: map[string]interface{}{"name": "Shafreeck"}})
	_ = graphStore.AddNode(ctx, memory.Node{ID: "morphz", Label: "Entity", Properties: map[string]interface{}{"name": "Morphz"}})
	_ = graphStore.AddEdge(ctx, memory.Edge{ID: "e_dev", FromNode: "shafreeck", ToNode: "morphz", Type: "DEVELOPED", Properties: map[string]interface{}{}})

	var client mockLLMClient
	memoryInjected := false
	client.onCompletion = func(ctx context.Context, messages []llm.Message, tools []llm.ToolDefinition, callCount int) (llm.Response, error) {
		// 检查 messages 里是否被成功注入了长期记忆系统消息
		for _, msg := range messages {
			contentLower := strings.ToLower(msg.Content)
			if msg.Role == "system" && strings.Contains(contentLower, "shafreeck") && strings.Contains(contentLower, "developed") {
				memoryInjected = true
			}
		}
		return llm.Response{
			Content: "是的，我知道 Morphz，它是 Shafreeck 开发的智能体框架。",
		}, nil
	}

	orc := NewOrchestrator(bus, store, &client, registry)
	if err := orc.Start(ctx); err != nil {
		t.Fatalf("failed to start: %v", err)
	}

	replyChan := make(chan event.Event, 1)
	sub, err := bus.Subscribe("chat/reply", func(ctx context.Context, ev event.Event) error {
		select {
		case replyChan <- ev:
		default:
		}
		return nil
	})
	if err != nil {
		t.Fatalf("subscribe error: %v", err)
	}
	defer sub.Unsubscribe()

	userEv := event.NewEvent(
		"user_trigger_4",
		"User",
		event.TypeUserMessage,
		"chat/user_message",
		map[string]interface{}{
			"session_id": "session_mem_test",
			"text":       "请问你知道 Morphz 吗？",
		},
	)

	if err := bus.Publish(ctx, userEv); err != nil {
		t.Fatalf("publish error: %v", err)
	}

	select {
	case <-replyChan:
		if !memoryInjected {
			t.Errorf("Expected long-term memory ('shafreeck DEVELOPED morphz') to be injected into LLM context, but it was not found")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Timeout waiting for memory test reply")
	}
}
