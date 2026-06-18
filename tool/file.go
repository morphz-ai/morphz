package tool

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"morphz/llm"
)

// WriteFileTool 本地物理文件写入工具
type WriteFileTool struct{}

// Name 返回工具标识符
func (w WriteFileTool) Name() string { return "write_file" }

// Definition 返回大模型自描述 JSON 格式
func (w WriteFileTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        "write_file",
		Description: "向指定路径的文件写入文本内容。如果文件不存在，会自动创建该文件。",
		Parameters: []byte(`{
			"type": "object",
			"properties": {
				"path": {
					"type": "string",
					"description": "要写入的文件路径，例如: test.txt"
				},
				"content": {
					"type": "string",
					"description": "要写入文件的文本内容"
				}
			},
			"required": ["path", "content"]
		}`),
	}
}

// Execute 物理执行写入
func (w WriteFileTool) Execute(ctx context.Context, arguments string) (string, error) {
	var args struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal([]byte(arguments), &args); err != nil {
		return "", fmt.Errorf("解析参数失败: %w", err)
	}

	err := os.WriteFile(args.Path, []byte(args.Content), 0644)
	if err != nil {
		return "", fmt.Errorf("写入文件失败: %w", err)
	}

	return fmt.Sprintf("成功向文件 '%s' 写入了 %d 字节数据。", args.Path, len(args.Content)), nil
}

// ReadFileTool 本地物理文件读取工具
type ReadFileTool struct{}

// Name 返回工具标识符
func (r ReadFileTool) Name() string { return "read_file" }

// Definition 返回大模型自描述 JSON 格式
func (r ReadFileTool) Definition() llm.ToolDefinition {
	return llm.ToolDefinition{
		Name:        "read_file",
		Description: "读取指定路径文件的文本内容并返回给大模型。",
		Parameters: []byte(`{
			"type": "object",
			"properties": {
				"path": {
					"type": "string",
					"description": "要读取的文件路径，例如: test.txt"
				}
			},
			"required": ["path"]
		}`),
	}
}

// Execute 物理执行读取
func (r ReadFileTool) Execute(ctx context.Context, arguments string) (string, error) {
	var args struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal([]byte(arguments), &args); err != nil {
		return "", fmt.Errorf("解析参数失败: %w", err)
	}

	data, err := os.ReadFile(args.Path)
	if err != nil {
		return "", fmt.Errorf("读取文件失败: %w", err)
	}

	return string(data), nil
}
