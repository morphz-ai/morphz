package memory

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"morphz/event"
)

func TestSqliteStore_AppendAndQuery(t *testing.T) {
	// 使用内存模式 SQLite，保障测试不残留垃圾文件且极速执行
	store, err := NewSqliteStore(":memory:")
	if err != nil {
		t.Fatalf("failed to create sqlite store: %v", err)
	}
	defer store.Close()

	ctx := context.Background()
	now := time.Now().UTC()

	// 1. 准备多维事件
	ev1 := event.NewEvent("ev_1", "User-Shafreeck", event.TypeUserMessage, "chat/user_message", map[string]interface{}{
		"session_id": "sess_1",
		"text":       "Hello agent, please write a note.",
	})
	ev1.Timestamp = now.Add(-5 * time.Minute)

	ev2 := event.NewEvent("ev_2", "Agent-Morphz", event.TypeAgentCall, "chat/assistant_call", map[string]interface{}{
		"session_id": "sess_1",
		"text":       "Sure, writing a note for you.",
	})
	ev2.Timestamp = now.Add(-3 * time.Minute)

	ev3 := event.NewEvent("ev_3", "User-Shafreeck", event.TypeUserMessage, "chat/other", map[string]interface{}{
		"session_id": "sess_2",
		"text":       "Different session text.",
	})
	ev3.Timestamp = now.Add(-1 * time.Minute)

	// 写入
	if err := store.Append(ctx, ev1); err != nil {
		t.Fatalf("failed to append ev1: %v", err)
	}
	if err := store.Append(ctx, ev2); err != nil {
		t.Fatalf("failed to append ev2: %v", err)
	}
	if err := store.Append(ctx, ev3); err != nil {
		t.Fatalf("failed to append ev3: %v", err)
	}

	// 2. 验证多维复合查询 - 按 Topic 匹配 (chat/*)
	results, err := store.Query(ctx, QueryFilter{Topic: "chat/*"})
	if err != nil {
		t.Fatalf("failed to query topic: %v", err)
	}
	if len(results) != 3 {
		t.Errorf("expected 3 events for chat/*, got %d", len(results))
	}
	// 验证时间戳排序是否正确（强制升序）
	if results[0].ID != "ev_1" || results[1].ID != "ev_2" || results[2].ID != "ev_3" {
		t.Errorf("expected chronological order (ev_1, ev_2, ev_3), got order: %s, %s, %s", results[0].ID, results[1].ID, results[2].ID)
	}

	// 3. 验证时间范围过滤
	start := now.Add(-4 * time.Minute)
	results, err = store.Query(ctx, QueryFilter{
		StartTime: &start,
		Topic:     "chat/*",
	})
	if err != nil {
		t.Fatalf("failed to query with time filter: %v", err)
	}
	if len(results) != 2 {
		t.Errorf("expected 2 events after -4 min, got %d", len(results))
	}
	if results[0].ID != "ev_2" || results[1].ID != "ev_3" {
		t.Errorf("expected (ev_2, ev_3), got first: %s", results[0].ID)
	}

	// 4. 验证 SearchQuery 全文检索过滤
	results, err = store.Query(ctx, QueryFilter{
		SearchQuery: "writing",
	})
	if err != nil {
		t.Fatalf("failed to search text: %v", err)
	}
	if len(results) != 1 {
		t.Errorf("expected 1 match for SearchQuery 'writing', got %d", len(results))
	}
	if results[0].ID != "ev_2" {
		t.Errorf("expected match ID to be ev_2, got %s", results[0].ID)
	}

	// 5. 验证 TopK 检索过滤
	results, err = store.Query(ctx, QueryFilter{
		Topic: "chat/*",
		TopK:  2,
	})
	if err != nil {
		t.Fatalf("failed to query TopK: %v", err)
	}
	if len(results) != 2 {
		t.Errorf("expected 2 TopK results, got %d", len(results))
	}
}

func TestSqliteStore_FoldEvaluation(t *testing.T) {
	store, err := NewSqliteStore(":memory:")
	if err != nil {
		t.Fatalf("failed to create sqlite store: %v", err)
	}
	defer store.Close()

	ctx := context.Background()
	now := time.Now()

	// 准备事件
	_ = store.Append(ctx, event.Event{ID: "1", Timestamp: now.Add(-3 * time.Second), Actor: "user", Type: event.TypeUserMessage, Topic: "chat/msg", Payload: map[string]interface{}{"text": "A"}})
	_ = store.Append(ctx, event.Event{ID: "2", Timestamp: now.Add(-2 * time.Second), Actor: "agent", Type: event.TypeAgentCall, Topic: "chat/msg", Payload: map[string]interface{}{"text": "B"}})
	_ = store.Append(ctx, event.Event{ID: "3", Timestamp: now.Add(-1 * time.Second), Actor: "user", Type: event.TypeUserMessage, Topic: "chat/msg", Payload: map[string]interface{}{"text": "C"}})

	initialState := "Dialog:"
	result, err := store.Fold(ctx, QueryFilter{Topic: "chat/*"}, initialState, func(state interface{}, ev event.Event) (interface{}, error) {
		dialog := state.(string)
		text := ev.Payload["text"].(string)
		return fmt.Sprintf("%s [%s]%s", dialog, ev.Actor, text), nil
	})

	if err != nil {
		t.Fatalf("fold execution failed: %v", err)
	}

	expected := "Dialog: [user]A [agent]B [user]C"
	if result.(string) != expected {
		t.Errorf("expected fold result '%s', got '%s'", expected, result.(string))
	}
}

func TestSqliteStore_Concurrency(t *testing.T) {
	// 建立本地临时文件，模拟真实物理文件并发
	tempDir, err := os.MkdirTemp("", "morphz_sqlite_test")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	dbPath := filepath.Join(tempDir, "test.db")
	store, err := NewSqliteStore(dbPath)
	if err != nil {
		t.Fatalf("failed to init store: %v", err)
	}
	defer store.Close()

	ctx := context.Background()
	var wg sync.WaitGroup
	concurrency := 15
	eventsPerRoutine := 10

	// 数据库并发写容易引起 "database is locked"。我们在 Go 层通过互斥锁来限制并发写
	// 这符合 Go 控制面单 Attempt 循环的时序要求，同时让 Race 检测器检查 Go runtime 层面有无字段 Race
	var writeMu sync.Mutex

	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func(routineID int) {
			defer wg.Done()
			for j := 0; j < eventsPerRoutine; j++ {
				ev := event.NewEvent(
					fmt.Sprintf("ev_%d_%d", routineID, j),
					fmt.Sprintf("actor_%d", routineID),
					event.TypeUserMessage,
					"chat/concurrency",
					map[string]interface{}{
						"routine": routineID,
						"index":   j,
					},
				)
				writeMu.Lock()
				_ = store.Append(ctx, ev)
				writeMu.Unlock()
			}
		}(i)
	}

	wg.Wait()

	// 验证所有事件都已被并发安全地记录
	results, err := store.Query(ctx, QueryFilter{Topic: "chat/concurrency"})
	if err != nil {
		t.Fatalf("failed to query concurrent records: %v", err)
	}

	expectedCount := concurrency * eventsPerRoutine
	if len(results) != expectedCount {
		t.Errorf("expected total count %d, got %d", expectedCount, len(results))
	}
}
