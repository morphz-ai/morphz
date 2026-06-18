package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strings"

	"github.com/sashabaranov/go-openai"
)

// OpenAIClient 实现 Client 接口，作为 OpenAI 兼容端点的适配器
type OpenAIClient struct {
	client         *openai.Client
	modelName      string
	embeddingModel string
	rustClient     *RustExecutorClient
}

// NewOpenAIClient 构造函数，支持 BaseURL /v1 自动补全
func NewOpenAIClient(apiKey, baseURL, modelName string) *OpenAIClient {
	config := openai.DefaultConfig(apiKey)

	if baseURL != "" {
		// 自动补全 /v1 后缀，确保兼容中转网关路由
		if !strings.HasSuffix(baseURL, "/v1") && !strings.HasSuffix(baseURL, "/v1/") {
			baseURL = strings.TrimSuffix(baseURL, "/") + "/v1"
		}
		config.BaseURL = baseURL
	}

	embModel := os.Getenv("OPENAI_EMBEDDING_MODEL")
	if embModel == "" {
		embModel = "text-embedding-3-small"
	}

	return &OpenAIClient{
		client:         openai.NewClientWithConfig(config),
		modelName:      modelName,
		embeddingModel: embModel,
		rustClient:     NewRustExecutorClient("http://127.0.0.1:8085"),
	}
}

// CreateCompletion 执行大模型 Chat Completion 推理
func (o *OpenAIClient) CreateCompletion(ctx context.Context, messages []Message, tools []ToolDefinition) (Response, error) {
	// 1. 转译 Messages 格式
	var openaiMessages []openai.ChatCompletionMessage
	for _, m := range messages {
		var toolCalls []openai.ToolCall
		for _, tc := range m.ToolCalls {
			toolCalls = append(toolCalls, openai.ToolCall{
				ID:   tc.ID,
				Type: openai.ToolType(tc.Type),
				Function: openai.FunctionCall{
					Name:      tc.FuncName,
					Arguments: tc.Arguments,
				},
			})
		}

		openaiMessages = append(openaiMessages, openai.ChatCompletionMessage{
			Role:       m.Role,
			Content:    m.Content,
			Name:       m.Name,
			ToolCallID: m.ToolCallID,
			ToolCalls:  toolCalls,
		})
	}

	// 2. 转译 Tools 格式
	var openaiTools []openai.Tool
	for _, t := range tools {
		openaiTools = append(openaiTools, openai.Tool{
			Type: openai.ToolTypeFunction,
			Function: &openai.FunctionDefinition{
				Name:        t.Name,
				Description: t.Description,
				Parameters:  json.RawMessage(t.Parameters),
			},
		})
	}

	// 3. 构建请求体
	req := openai.ChatCompletionRequest{
		Model:    o.modelName,
		Messages: openaiMessages,
	}
	if len(openaiTools) > 0 {
		req.Tools = openaiTools
	}

	// 4. 调用 API
	resp, err := o.client.CreateChatCompletion(ctx, req)
	if err != nil {
		extraTip := ""
		errStr := err.Error()
		if strings.Contains(errStr, "400") || strings.Contains(errStr, "INVALID_ARGUMENT") {
			extraTip = "\n💡 [排查建议] 400 INVALID_ARGUMENT 错误通常是由于在自定义 API 代理上请求了不支持的模型名称造成的。请确认您的 .env 文件中 OPENAI_MODEL 配置是否与代理端点匹配 (例如 Gemini 应使用 gemini-1.5-flash，DeepSeek 应使用 deepseek-chat 等)。"
		}
		return Response{}, fmt.Errorf("%s%s", err.Error(), extraTip)
	}

	choice := resp.Choices[0]

	// 5. 转译 Response 格式
	var resToolCalls []ToolCall
	for _, tc := range choice.Message.ToolCalls {
		resToolCalls = append(resToolCalls, ToolCall{
			ID:        tc.ID,
			Type:      string(tc.Type),
			FuncName:  tc.Function.Name,
			Arguments: tc.Function.Arguments,
		})
	}

	return Response{
		Content:   choice.Message.Content,
		ToolCalls: resToolCalls,
	}, nil
}

// CreateEmbedding 生成输入文本的向量特征值（嵌入向量）
func (o *OpenAIClient) CreateEmbedding(ctx context.Context, text string) ([]float32, error) {
	// Level 1: 优先尝试官方远程 API (如 OpenAI/Gemini)
	req := openai.EmbeddingRequest{
		Input: []string{text},
		Model: openai.EmbeddingModel(o.embeddingModel),
	}
	resp, err := o.client.CreateEmbeddings(ctx, req)
	if err == nil && len(resp.Data) > 0 {
		return resp.Data[0].Embedding, nil
	}

	// Level 2 [Fallback]: 委托本地 Rust gRPC 执行端计算高精度 BGE 向量
	if o.rustClient != nil {
		if localVec, err := o.rustClient.ComputeEmbedding(ctx, text); err == nil {
			return localVec, nil
		}
	}

	// Level 3 [Fallback]: 极端情况下退化为最轻量的本地 N-Gram Hashing 向量
	return localHashingEmbedding(text), nil
}

func localHashingEmbedding(text string) []float32 {
	text = strings.ToLower(text)
	var runes []rune
	for _, r := range text {
		// 允许英文字母、数字和常见字符，中文（0x4e00-0x9fff）
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || (r >= 0x4e00 && r <= 0x9fff) || r == '(' || r == ')' {
			runes = append(runes, r)
		} else {
			runes = append(runes, ' ')
		}
	}
	cleaned := string(runes)
	words := strings.Fields(cleaned)

	const dimension = 256
	vec := make([]float32, dimension)

	addHash := func(term string) {
		h := uint32(0)
		for i := 0; i < len(term); i++ {
			h = h*31 + uint32(term[i])
		}
		idx := h % dimension
		vec[idx] += 1.0
	}

	for _, w := range words {
		addHash(w)
		if len(w) > 2 {
			for i := 0; i < len(w)-1; i++ {
				addHash(w[i : i+2])
			}
		}
	}

	// L2 归一化，使得 Cosine Similarity 简单等同于点积计算
	var sumSq float64
	for i := 0; i < dimension; i++ {
		sumSq += float64(vec[i] * vec[i])
	}
	if sumSq > 0 {
		norm := float32(math.Sqrt(sumSq))
		for i := 0; i < dimension; i++ {
			vec[i] /= norm
		}
	}
	return vec
}
