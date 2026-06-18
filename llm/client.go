package llm

import "context"

// Message 对应大模型交互中的单条消息
type Message struct {
	Role       string     // system, user, assistant, tool
	Content    string
	Name       string     // 对应 tool 消息的工具名称
	ToolCallID string     // 对应 tool 消息的 ToolCall ID
	ToolCalls  []ToolCall // 对应 assistant 消息的工具调用请求
}

// ToolCall 代表大模型决策要求调用的工具信息
type ToolCall struct {
	ID        string
	Type      string
	FuncName  string
	Arguments string
}

// ToolDefinition 自描述工具声明
type ToolDefinition struct {
	Name        string
	Description string
	Parameters  []byte // JSON Schema
}

// Response 大模型响应结果，包含文本或工具调用意图
type Response struct {
	Content   string
	ToolCalls []ToolCall
}

// Client 定义了大模型底层驱动的核心行为接口
type Client interface {
	CreateCompletion(ctx context.Context, messages []Message, tools []ToolDefinition) (Response, error)
	// CreateEmbedding 生成文本的 1536/3072 维浮点向量
	CreateEmbedding(ctx context.Context, text string) ([]float32, error)
}
