package event

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
)

// Handler 处理事件的函数定义
type Handler func(ctx context.Context, ev Event) error

// Bus 接口定义了事件发布与订阅的核心行为
type Bus interface {
	Subscribe(topicPattern string, handler Handler) (Subscription, error)
	Publish(ctx context.Context, ev Event) error
}

// Subscription 代表一次动态订阅
type Subscription interface {
	ID() string
	TopicPattern() string
	Unsubscribe()
}

// InMemorySubscription 实现 Subscription 接口
type InMemorySubscription struct {
	id           string
	topicPattern string
	handler      Handler
	bus          *InMemoryEventBus
}

// ID 返回订阅标识
func (s *InMemorySubscription) ID() string {
	return s.id
}

// TopicPattern 返回主题过滤匹配模式
func (s *InMemorySubscription) TopicPattern() string {
	return s.topicPattern
}

// Unsubscribe 退订事件监听
func (s *InMemorySubscription) Unsubscribe() {
	s.bus.unsubscribe(s.id)
}

// InMemoryEventBus 基于内存和 RWMutex 的并发安全事件总线
type InMemoryEventBus struct {
	mu            sync.RWMutex
	subscriptions map[string]*InMemorySubscription
	subCounter    uint64
	errorHandler  func(err error, ev Event)
}

// NewInMemoryEventBus 构造函数
func NewInMemoryEventBus() *InMemoryEventBus {
	return &InMemoryEventBus{
		subscriptions: make(map[string]*InMemorySubscription),
		errorHandler:  func(err error, ev Event) {},
	}
}

// SetErrorHandler 设置异常捕获钩子，方便日志追踪或重试
func (b *InMemoryEventBus) SetErrorHandler(fn func(err error, ev Event)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.errorHandler = fn
}

// Subscribe 注册一个事件订阅
func (b *InMemoryEventBus) Subscribe(topicPattern string, handler Handler) (Subscription, error) {
	if handler == nil {
		return nil, errors.New("handler cannot be nil")
	}

	b.mu.Lock()
	defer b.mu.Unlock()

	idVal := atomic.AddUint64(&b.subCounter, 1)
	subID := fmt.Sprintf("sub_%d", idVal)

	sub := &InMemorySubscription{
		id:           subID,
		topicPattern: topicPattern,
		handler:      handler,
		bus:          b,
	}

	b.subscriptions[subID] = sub
	return sub, nil
}

func (b *InMemoryEventBus) unsubscribe(id string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.subscriptions, id)
}

// match 评估 topic 是否符合 pattern
func match(pattern, topic string) bool {
	if pattern == "*" {
		return true
	}
	if pattern == topic {
		return true
	}
	// 支持 prefix/* 前缀通配符匹配
	if strings.HasSuffix(pattern, "/*") {
		prefix := strings.TrimSuffix(pattern, "/*")
		return strings.HasPrefix(topic, prefix+"/")
	}
	return false
}

// Publish 异步并发发布事件
func (b *InMemoryEventBus) Publish(ctx context.Context, ev Event) error {
	b.mu.RLock()
	var syncSubs []*InMemorySubscription
	var asyncSubs []*InMemorySubscription
	for _, sub := range b.subscriptions {
		if match(sub.topicPattern, ev.Topic) {
			// * 模式是 WAL 底层审计感知，需要同步执行落库以保证后面的业务查询一致性
			if sub.topicPattern == "*" {
				syncSubs = append(syncSubs, sub)
			} else {
				asyncSubs = append(asyncSubs, sub)
			}
		}
	}
	b.mu.RUnlock()

	// 1. 同步执行高优先级底层审计
	for _, sub := range syncSubs {
		err := func(s *InMemorySubscription) error {
			defer func() {
				if r := recover(); r != nil {
					errPanic := fmt.Errorf("panic caught in sync event handler: %v", r)
					b.mu.RLock()
					b.errorHandler(errPanic, ev)
					b.mu.RUnlock()
				}
			}()
			return s.handler(ctx, ev)
		}(sub)
		if err != nil {
			b.mu.RLock()
			b.errorHandler(err, ev)
			b.mu.RUnlock()
		}
	}

	// 2. 并发非阻塞异步派发其他业务 Handler
	for _, sub := range asyncSubs {
		go func(s *InMemorySubscription) {
			defer func() {
				if r := recover(); r != nil {
					errPanic := fmt.Errorf("panic caught in async event handler: %v", r)
					b.mu.RLock()
					b.errorHandler(errPanic, ev)
					b.mu.RUnlock()
				}
			}()

			if err := s.handler(ctx, ev); err != nil {
				b.mu.RLock()
				b.errorHandler(err, ev)
				b.mu.RUnlock()
			}
		}(sub)
	}

	return nil
}
