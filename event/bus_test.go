package event

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestInMemoryEventBus_PublishSubscribe(t *testing.T) {
	bus := NewInMemoryEventBus()
	ctx := context.Background()

	var mu sync.Mutex
	var receivedCount int32
	var receivedEvent Event

	sub, err := bus.Subscribe("github/build", func(ctx context.Context, ev Event) error {
		atomic.AddInt32(&receivedCount, 1)
		mu.Lock()
		receivedEvent = ev
		mu.Unlock()
		return nil
	})
	if err != nil {
		t.Fatalf("failed to subscribe: %v", err)
	}
	if sub.TopicPattern() != "github/build" {
		t.Errorf("expected topic pattern github/build, got %s", sub.TopicPattern())
	}

	payload := map[string]interface{}{"status": "success"}
	ev := NewEvent("1", "user-1", TypeUserMessage, "github/build", payload)

	if err := bus.Publish(ctx, ev); err != nil {
		t.Fatalf("failed to publish: %v", err)
	}

	// 给异步分发预留时间
	time.Sleep(50 * time.Millisecond)

	if atomic.LoadInt32(&receivedCount) != 1 {
		t.Errorf("expected 1 event received, got %d", receivedCount)
	}

	mu.Lock()
	id := receivedEvent.ID
	actor := receivedEvent.Actor
	mu.Unlock()

	if id != "1" || actor != "user-1" {
		t.Errorf("invalid event payload received")
	}
}

func TestInMemoryEventBus_WildcardMatching(t *testing.T) {
	bus := NewInMemoryEventBus()
	ctx := context.Background()

	var githubCount int32
	var allCount int32

	_, _ = bus.Subscribe("github/*", func(ctx context.Context, ev Event) error {
		atomic.AddInt32(&githubCount, 1)
		return nil
	})

	_, _ = bus.Subscribe("*", func(ctx context.Context, ev Event) error {
		atomic.AddInt32(&allCount, 1)
		return nil
	})

	ev1 := NewEvent("1", "tester", TypeUserMessage, "github/commit", nil)
	_ = bus.Publish(ctx, ev1)

	ev2 := NewEvent("2", "tester", TypeUserMessage, "other/topic", nil)
	_ = bus.Publish(ctx, ev2)

	time.Sleep(50 * time.Millisecond)

	if atomic.LoadInt32(&githubCount) != 1 {
		t.Errorf("expected 1 github event, got %d", githubCount)
	}
	if atomic.LoadInt32(&allCount) != 2 {
		t.Errorf("expected 2 all events, got %d", allCount)
	}
}

func TestInMemoryEventBus_Unsubscribe(t *testing.T) {
	bus := NewInMemoryEventBus()
	ctx := context.Background()

	var count int32
	sub, _ := bus.Subscribe("test/topic", func(ctx context.Context, ev Event) error {
		atomic.AddInt32(&count, 1)
		return nil
	})

	ev := NewEvent("1", "tester", TypeUserMessage, "test/topic", nil)
	_ = bus.Publish(ctx, ev)

	time.Sleep(50 * time.Millisecond)
	if atomic.LoadInt32(&count) != 1 {
		t.Fatalf("expected 1, got %d", count)
	}

	sub.Unsubscribe()

	_ = bus.Publish(ctx, ev)
	time.Sleep(50 * time.Millisecond)

	if atomic.LoadInt32(&count) != 1 {
		t.Errorf("expected count to remain 1, got %d", count)
	}
}

func TestInMemoryEventBus_PanicRecovery(t *testing.T) {
	bus := NewInMemoryEventBus()
	ctx := context.Background()

	var errCaught error
	var errWg sync.WaitGroup
	errWg.Add(1)

	bus.SetErrorHandler(func(err error, ev Event) {
		errCaught = err
		errWg.Done()
	})

	_, _ = bus.Subscribe("panic/topic", func(ctx context.Context, ev Event) error {
		panic("boom")
	})

	ev := NewEvent("1", "tester", TypeUserMessage, "panic/topic", nil)
	_ = bus.Publish(ctx, ev)

	if waitTimeout(&errWg, 200*time.Millisecond) {
		t.Fatal("error handler was not called within timeout")
	}

	if errCaught == nil {
		t.Fatal("expected error to be caught, got nil")
	}
}

func TestInMemoryEventBus_ConcurrencyRace(t *testing.T) {
	bus := NewInMemoryEventBus()
	ctx := context.Background()

	var wg sync.WaitGroup
	var activeSubs []Subscription
	var subMu sync.Mutex

	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sub, _ := bus.Subscribe("race/*", func(ctx context.Context, ev Event) error {
				return nil
			})
			subMu.Lock()
			activeSubs = append(activeSubs, sub)
			subMu.Unlock()
		}()
	}

	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ev := NewEvent("id", "race-tester", TypeUserMessage, "race/test", nil)
			_ = bus.Publish(ctx, ev)
		}()
	}

	wg.Wait()

	for _, sub := range activeSubs {
		wg.Add(1)
		go func(s Subscription) {
			defer wg.Done()
			s.Unsubscribe()
		}(sub)
	}
	wg.Wait()
}

func waitTimeout(wg *sync.WaitGroup, timeout time.Duration) bool {
	c := make(chan struct{})
	go func() {
		defer close(c)
		wg.Wait()
	}()
	select {
	case <-c:
		return false
	case <-time.After(timeout):
		return true
	}
}
