package memory

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"morphz/event"
)

// QueryFilter 用于筛选情境记忆的检索条件
type QueryFilter struct {
	StartTime *time.Time
	EndTime   *time.Time
	Actors    []string
	Types     []event.EventType
	Topic     string // 支持精准或前缀通配符过滤

	// 预留全文检索和向量检索字段以满足后续扩展
	SearchQuery string    // 全文检索关键词（FTS），匹配事件 Payload 文本或 Topic
	Vector      []float32 // 向量搜索对应的 Embedding 向量
	TopK        int       // 返回的最相关事件数量限制
}

// FoldFunc 对事件流进行折叠累加的纯函数定义
type FoldFunc func(state interface{}, ev event.Event) (interface{}, error)

// EventStore 定义事件历史物理存储的接口
type EventStore interface {
	Append(ctx context.Context, ev event.Event) error
	Query(ctx context.Context, filter QueryFilter) ([]event.Event, error)
	Fold(ctx context.Context, filter QueryFilter, initial interface{}, foldFn FoldFunc) (interface{}, error)
}

// InMemoryStore 基于内存及 RWMutex 的并发安全事件存储实现
type InMemoryStore struct {
	mu     sync.RWMutex
	events []event.Event
}

// NewInMemoryStore 构造函数
func NewInMemoryStore() *InMemoryStore {
	return &InMemoryStore{
		events: make([]event.Event, 0),
	}
}

// Append 顺序追加事件到 WAL 事实日志
func (s *InMemoryStore) Append(ctx context.Context, ev event.Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, ev)
	return nil
}

func matchTopic(pattern, topic string) bool {
	if pattern == "" || pattern == "*" {
		return true
	}
	if pattern == topic {
		return true
	}
	if strings.HasSuffix(pattern, "/*") {
		prefix := strings.TrimSuffix(pattern, "/*")
		return strings.HasPrefix(topic, prefix+"/")
	}
	return false
}

// Query 按照 QueryFilter 条件并发安全地检索事件
func (s *InMemoryStore) Query(ctx context.Context, filter QueryFilter) ([]event.Event, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var result []event.Event
	for _, ev := range s.events {
		if filter.StartTime != nil && ev.Timestamp.Before(*filter.StartTime) {
			continue
		}
		if filter.EndTime != nil && ev.Timestamp.After(*filter.EndTime) {
			continue
		}

		if len(filter.Actors) > 0 {
			matched := false
			for _, actor := range filter.Actors {
				if ev.Actor == actor {
					matched = true
					break
				}
			}
			if !matched {
				continue
			}
		}

		if len(filter.Types) > 0 {
			matched := false
			for _, t := range filter.Types {
				if ev.Type == t {
					matched = true
					break
				}
			}
			if !matched {
				continue
			}
		}

		if filter.Topic != "" && !matchTopic(filter.Topic, ev.Topic) {
			continue
		}

		result = append(result, ev)
	}

	// 按照 Timestamp 纳米级时间戳升序排序，使用 SliceStable 保证在时间戳相同时维持物理追加顺序
	sort.SliceStable(result, func(i, j int) bool {
		return result[i].Timestamp.Before(result[j].Timestamp)
	})

	return result, nil
}

// Fold 使用 FoldFunc 对过滤出来的事件日志流运行折叠累加计算，输出投影状态
func (s *InMemoryStore) Fold(ctx context.Context, filter QueryFilter, initial interface{}, foldFn FoldFunc) (interface{}, error) {
	events, err := s.Query(ctx, filter)
	if err != nil {
		return nil, err
	}

	state := initial
	for _, ev := range events {
		state, err = foldFn(state, ev)
		if err != nil {
			return nil, err
		}
	}
	return state, nil
}
