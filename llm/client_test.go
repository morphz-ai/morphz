package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/sashabaranov/go-openai"
)

func TestOpenAIClient_CreateCompletion_Success(t *testing.T) {
	// 启动本地 Mock 代理服务器，截获并模拟大模型 HTTP 接口行为
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("expected path /v1/chat/completions, got %s", r.URL.Path)
		}

		resp := openai.ChatCompletionResponse{
			Choices: []openai.ChatCompletionChoice{
				{
					Message: openai.ChatCompletionMessage{
						Role:    openai.ChatMessageRoleAssistant,
						Content: "Thinking...",
						ToolCalls: []openai.ToolCall{
							{
								ID:   "call_1",
								Type: openai.ToolTypeFunction,
								Function: openai.FunctionCall{
									Name:      "write_file",
									Arguments: `{"path":"a.txt","content":"hello"}`,
								},
							},
						},
					},
				},
			},
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	// 实例化客户端，将 BaseURL 指向 Mock 端点，并自动验证智能 /v1 补全功能
	client := NewOpenAIClient("mock-api-key", server.URL, "mock-model")

	messages := []Message{
		{Role: "user", Content: "Write hello to a.txt"},
	}
	tools := []ToolDefinition{
		{Name: "write_file", Description: "Write to file", Parameters: []byte(`{}`)},
	}

	response, err := client.CreateCompletion(context.Background(), messages, tools)
	if err != nil {
		t.Fatalf("failed to create completion: %v", err)
	}

	if response.Content != "Thinking..." {
		t.Errorf("expected Content Thinking..., got %s", response.Content)
	}
	if len(response.ToolCalls) != 1 {
		t.Fatalf("expected 1 tool call, got %d", len(response.ToolCalls))
	}

	tc := response.ToolCalls[0]
	if tc.ID != "call_1" || tc.FuncName != "write_file" || tc.Arguments != `{"path":"a.txt","content":"hello"}` {
		t.Errorf("invalid tool call mapped: %v", tc)
	}
}

func TestOpenAIClient_CreateEmbedding_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/embeddings" {
			t.Errorf("expected path /v1/embeddings, got %s", r.URL.Path)
		}

		resp := openai.EmbeddingResponse{
			Data: []openai.Embedding{
				{
					Embedding: []float32{0.1, 0.2, 0.3},
				},
			},
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	client := NewOpenAIClient("mock-api-key", server.URL, "mock-model")
	emb, err := client.CreateEmbedding(context.Background(), "hello")
	if err != nil {
		t.Fatalf("failed to create embedding: %v", err)
	}

	if len(emb) != 3 || emb[0] != 0.1 || emb[1] != 0.2 || emb[2] != 0.3 {
		t.Errorf("expected [0.1, 0.2, 0.3], got %v", emb)
	}
}
