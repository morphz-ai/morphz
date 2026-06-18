package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// RustExecutorClient 通过 HTTP 连接到 Rust 执行端本地推理服务 (127.0.0.1)
type RustExecutorClient struct {
	baseURL string
	client  *http.Client
}

type EmbedRequest struct {
	Text string `json:"text"`
}

type EmbedResponse struct {
	Embedding []float32 `json:"embedding"`
	Error     string    `json:"error,omitempty"`
}

// NewRustExecutorClient 创建一个指向本地 TCP 推理端口的客户端
func NewRustExecutorClient(baseURL string) *RustExecutorClient {
	return &RustExecutorClient{
		baseURL: baseURL,
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// ComputeEmbedding 请求 Rust 推理端计算文本的 Embedding 向量
func (r *RustExecutorClient) ComputeEmbedding(ctx context.Context, text string) ([]float32, error) {
	reqBody, err := json.Marshal(EmbedRequest{Text: text})
	if err != nil {
		return nil, fmt.Errorf("failed to marshal embed request: %w", err)
	}

	url := fmt.Sprintf("%s/embed", r.baseURL)
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(reqBody))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := r.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http call to rust executor failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("rust executor returned status code %d", resp.StatusCode)
	}

	var res EmbedResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	if res.Error != "" {
		return nil, fmt.Errorf("rust executor returned error: %s", res.Error)
	}

	return res.Embedding, nil
}
