package tool

import (
	"context"
	"fmt"
	"sync"

	"morphz/llm"
)

// Tool 接口定义，使工具自描述且可执行
type Tool interface {
	Name() string
	Definition() llm.ToolDefinition
	Execute(ctx context.Context, arguments string) (string, error)
}

// Registry 管理项目中所有可用工具的并发安全注册表
type Registry struct {
	mu    sync.RWMutex
	tools map[string]Tool
}

// NewRegistry 构造函数
func NewRegistry() *Registry {
	return &Registry{
		tools: make(map[string]Tool),
	}
}

// Register 注册一个工具，若有重复工具会被覆盖
func (r *Registry) Register(t Tool) error {
	if t == nil {
		return fmt.Errorf("tool cannot be nil")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.tools[t.Name()] = t
	return nil
}

// Get 根据名称检索工具
func (r *Registry) Get(name string) (Tool, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	t, ok := r.tools[name]
	return t, ok
}

// Definitions 提取所有已注册工具的大模型 Schema 描述列表
func (r *Registry) Definitions() []llm.ToolDefinition {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var defs []llm.ToolDefinition
	for _, t := range r.tools {
		defs = append(defs, t.Definition())
	}
	return defs
}
