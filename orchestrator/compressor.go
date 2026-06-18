package orchestrator

import (
	"context"
	"fmt"
	"morphz/llm"
)

// Compressor 负责对 Agent 上下文进行剪裁和压缩
type Compressor struct {
	maxToolOutputLen int
	maxMessageCount  int
	client           llm.Client
}

// NewCompressor 构造函数
func NewCompressor(maxToolOutputLen int, maxMessageCount int, client llm.Client) *Compressor {
	return &Compressor{
		maxToolOutputLen: maxToolOutputLen,
		maxMessageCount:  maxMessageCount,
		client:           client,
	}
}

// CompressToolOutput 对大体积的工具输出进行静态截断
func (c *Compressor) CompressToolOutput(text string) string {
	if c.maxToolOutputLen <= 0 || len(text) <= c.maxToolOutputLen {
		return text
	}
	half := c.maxToolOutputLen / 2
	if half > len(text)/2 {
		half = len(text) / 2
	}
	truncated := len(text) - (half * 2)
	return fmt.Sprintf("%s\n\n... [已自动截断其核心 %d 字符以保全 Context，首尾展示如下] ...\n\n%s", 
		text[:half], truncated, text[len(text)-half:])
}

// CompressMessages 动态压缩消息历史。如果消息总数超过设定值，
// 将较早的消息（不含系统消息和最近几轮）汇总压缩为一条 Summary 消息。
func (c *Compressor) CompressMessages(ctx context.Context, messages []llm.Message) ([]llm.Message, error) {
	if c.maxMessageCount <= 0 || len(messages) <= c.maxMessageCount {
		return messages, nil
	}

	// 至少保留系统消息（第一条）和最近 4 条消息
	keepRecent := 4
	if len(messages) < keepRecent+2 {
		return messages, nil
	}

	var systemMsg *llm.Message
	var toCompress []llm.Message
	var keepMsgs []llm.Message

	// 寻找切分点：从设定的 keepRecent 倒数位置向前寻找最近的 "user" 消息，
	// 确保 keepMsgs 以 user 消息为起点，从而完整保留随后的 assistant/tool 完整会话对。
	splitIdx := len(messages) - keepRecent
	if splitIdx < 1 {
		splitIdx = 1
	}
	for splitIdx > 1 {
		if messages[splitIdx].Role == "user" {
			break
		}
		splitIdx--
	}

	// 如果由于某种原因找不到合法的 user 消息作为切分，则不进行压缩以确保合规性
	if splitIdx <= 1 && messages[splitIdx].Role != "user" {
		return messages, nil
	}

	for i, msg := range messages {
		if i == 0 && msg.Role == "system" {
			systemMsg = &msg
			continue
		}
		if i >= splitIdx {
			keepMsgs = append(keepMsgs, msg)
		} else {
			toCompress = append(toCompress, msg)
		}
	}

	if len(toCompress) == 0 {
		return messages, nil
	}

	// 调用大模型对 toCompress 进行摘要压缩
	summary, err := c.summarizeMessages(ctx, toCompress)
	if err != nil {
		// 降级策略：如果压缩失败，直接丢弃过久的历史消息，不影响主流程
		summary = "[系统警告：由于上下文过长且自动摘要失败，在此处省略了较早的历史对话记录]"
	}

	result := make([]llm.Message, 0, len(keepMsgs)+2)
	if systemMsg != nil {
		result = append(result, *systemMsg)
	}

	// 插入摘要消息作为一段系统背景注入
	result = append(result, llm.Message{
		Role:    "system",
		Content: fmt.Sprintf("这是较早之前的对话历史摘要，供你参考：\n%s", summary),
	})
	result = append(result, keepMsgs...)

	return result, nil
}

func (c *Compressor) summarizeMessages(ctx context.Context, msgs []llm.Message) (string, error) {
	if c.client == nil {
		return "", fmt.Errorf("llm client is nil")
	}

	// 构建用于摘要的 messages
	promptMsgs := []llm.Message{
		{
			Role:    "system",
			Content: "你是一个历史对话总结器。请你用极其精简、结构化的中文，总结给定的多轮历史对话。只需要输出总结内容，不要带任何前缀或解释。",
		},
	}

	var contentBuilder string
	for _, m := range msgs {
		nameStr := ""
		if m.Name != "" {
			nameStr = fmt.Sprintf(" (工具: %s)", m.Name)
		}
		contentBuilder += fmt.Sprintf("[%s]%s: %s\n", m.Role, nameStr, m.Content)
	}

	promptMsgs = append(promptMsgs, llm.Message{
		Role:    "user",
		Content: fmt.Sprintf("请总结以下对话历史：\n%s", contentBuilder),
	})

	resp, err := c.client.CreateCompletion(ctx, promptMsgs, nil)
	if err != nil {
		return "", err
	}
	return resp.Content, nil
}
