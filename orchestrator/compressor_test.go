package orchestrator

import (
	"context"
	"strings"
	"testing"

	"morphz/llm"
)

func TestCompressor_CompressToolOutput(t *testing.T) {
	compressor := NewCompressor(20, 10, nil)

	// 测试不需要截断的情况
	shortText := "12345"
	if res := compressor.CompressToolOutput(shortText); res != shortText {
		t.Errorf("Expected '%s', got '%s'", shortText, res)
	}

	// 测试截断
	longText := strings.Repeat("abcdefghijklmnopqrstuvwxyz", 40)
	res := compressor.CompressToolOutput(longText)
	if !strings.Contains(res, "已自动截断其核心") {
		t.Errorf("Expected output to be truncated, got: %s", res)
	}
	if len(res) >= len(longText) {
		t.Errorf("Expected truncated string to be shorter than original, got len=%d", len(res))
	}
}

func TestCompressor_CompressMessages(t *testing.T) {
	mockClient := &mockLLMClient{
		onCompletion: func(ctx context.Context, messages []llm.Message, tools []llm.ToolDefinition, callCount int) (llm.Response, error) {
			// 返回一段总结
			return llm.Response{
				Content: "总结：用户和助手进行了一些问答。",
			}, nil
		},
	}

	// 限制消息条数最多为 6 条
	compressor := NewCompressor(100, 6, mockClient)

	msgs := []llm.Message{
		{Role: "system", Content: "System prompt"},
		{Role: "user", Content: "Msg 1"},
		{Role: "assistant", Content: "Reply 1"},
		{Role: "user", Content: "Msg 2"},
		{Role: "assistant", Content: "Reply 2"},
		{Role: "user", Content: "Msg 3"},
		{Role: "assistant", Content: "Reply 3"},
		{Role: "user", Content: "Msg 4"},
		{Role: "assistant", Content: "Reply 4"},
	}

	resMsgs, err := compressor.CompressMessages(context.Background(), msgs)
	if err != nil {
		t.Fatalf("Failed to compress messages: %v", err)
	}

	// 原本有 9 条，压缩后应该精简
	// 期望：1 个 systemMsg + 1 个 总结 systemMsg + 最近 4 个 msg = 6 个 msg
	if len(resMsgs) != 6 {
		t.Errorf("Expected 6 messages after compression, got %d", len(resMsgs))
	}

	if resMsgs[0].Content != "System prompt" {
		t.Errorf("Expected first message to remain system prompt, got: %s", resMsgs[0].Content)
	}

	if !strings.Contains(resMsgs[1].Content, "总结：用户和助手进行了一些问答") {
		t.Errorf("Expected second message to contain history summary, got: %s", resMsgs[1].Content)
	}

	// 倒数 4 个消息应该和原来 keepRecent 一致
	if resMsgs[2].Content != "Msg 3" || resMsgs[5].Content != "Reply 4" {
		t.Errorf("Expected last 4 messages to match the original recent ones")
	}
}
