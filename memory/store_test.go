package memory

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"morphz/event"
)

func TestInMemoryStore_AppendAndQuery(t *testing.T) {
	store := NewInMemoryStore()
	ctx := context.Background()

	ev1 := event.NewEvent("1", "user", event.TypeUserMessage, "chat/msg", map[string]interface{}{"text": "hello"})
	ev2 := event.NewEvent("2", "agent", event.TypeAgentCall, "chat/reply", map[string]interface{}{"text": "hi"})

	_ = store.Append(ctx, ev1)
	_ = store.Append(ctx, ev2)

	// 1. 过滤查询 chat/*
	events, err := store.Query(ctx, QueryFilter{Topic: "chat/*"})
	if err != nil {
		t.Fatalf("failed to query: %v", err)
	}
	if len(events) != 2 {
		t.Errorf("expected 2 events, got %d", len(events))
	}

	// 2. 过滤 Actor 为 user
	events, _ = store.Query(ctx, QueryFilter{Actors: []string{"user"}})
	if len(events) != 1 || events[0].ID != "1" {
		t.Errorf("expected event 1 from user")
	}

	// 3. 过滤 EventType
	events, _ = store.Query(ctx, QueryFilter{Types: []event.EventType{event.TypeAgentCall}})
	if len(events) != 1 || events[0].ID != "2" {
		t.Errorf("expected event 2 with AgentCall type")
	}
}

func TestInMemoryStore_QueryTimeRange(t *testing.T) {
	store := NewInMemoryStore()
	ctx := context.Background()

	now := time.Now()
	ev1 := event.Event{ID: "1", Timestamp: now.Add(-10 * time.Minute), Topic: "t"}
	ev2 := event.Event{ID: "2", Timestamp: now.Add(-5 * time.Minute), Topic: "t"}
	ev3 := event.Event{ID: "3", Timestamp: now, Topic: "t"}

	_ = store.Append(ctx, ev1)
	_ = store.Append(ctx, ev2)
	_ = store.Append(ctx, ev3)

	start := now.Add(-7 * time.Minute)
	end := now.Add(-2 * time.Minute)
	events, err := store.Query(ctx, QueryFilter{
		StartTime: &start,
		EndTime:   &end,
	})
	if err != nil {
		t.Fatalf("failed to query time range: %v", err)
	}
	if len(events) != 1 || events[0].ID != "2" {
		t.Errorf("expected only event 2, got %d elements", len(events))
	}
}

func TestInMemoryStore_FoldEvaluation(t *testing.T) {
	store := NewInMemoryStore()
	ctx := context.Background()

	ev1 := event.NewEvent("1", "user", event.TypeUserMessage, "chat", map[string]interface{}{"text": "A"})
	ev2 := event.NewEvent("2", "agent", event.TypeAgentCall, "chat", map[string]interface{}{"text": "B"})
	ev3 := event.NewEvent("3", "user", event.TypeUserMessage, "chat", map[string]interface{}{"text": "C"})

	_ = store.Append(ctx, ev1)
	_ = store.Append(ctx, ev2)
	_ = store.Append(ctx, ev3)

	// 使用 Fold 模拟拼接历史 Prompt 过程
	initialPrompt := "Conversation History:\n"
	resultState, err := store.Fold(ctx, QueryFilter{Topic: "chat"}, initialPrompt, func(state interface{}, ev event.Event) (interface{}, error) {
		prompt := state.(string)
		text := ev.Payload["text"].(string)
		return fmt.Sprintf("%s- %s: %s\n", prompt, ev.Actor, text), nil
	})

	if err != nil {
		t.Fatalf("failed to fold context: %v", err)
	}

	expected := "Conversation History:\n- user: A\n- agent: B\n- user: C\n"
	if resultState.(string) != expected {
		t.Errorf("expected prompt:\n%s\ngot:\n%s", expected, resultState.(string))
	}
}

func TestInMemoryStore_Concurrency(t *testing.T) {
	store := NewInMemoryStore()
	ctx := context.Background()

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			ev := event.NewEvent(fmt.Sprintf("id-%d", index), "tester", event.TypeUserMessage, "test", nil)
			_ = store.Append(ctx, ev)
		}(i)
	}

	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = store.Query(ctx, QueryFilter{Topic: "test"})
		}()
	}

	wg.Wait()
}
