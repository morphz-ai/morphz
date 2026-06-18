package tool

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestRegistry_RegisterAndGet(t *testing.T) {
	r := NewRegistry()
	w := WriteFileTool{}
	_ = r.Register(w)

	tool, ok := r.Get("write_file")
	if !ok || tool.Name() != "write_file" {
		t.Fatal("failed to get registered tool")
	}

	defs := r.Definitions()
	if len(defs) != 1 || defs[0].Name != "write_file" {
		t.Fatal("invalid tool definitions count")
	}
}

func TestWriteFileAndReadFileTools(t *testing.T) {
	ctx := context.Background()
	tmpDir := os.TempDir()
	testFile := filepath.Join(tmpDir, "morphz_test_tool.txt")

	// 测试完毕自动执行物理删除，保证宿主机环境纯净
	defer os.Remove(testFile)

	w := WriteFileTool{}
	r := ReadFileTool{}

	// 1. 物理写入执行测试
	writeArgs := fmt.Sprintf(`{"path":"%s","content":"hello world"}`, testFile)
	output, err := w.Execute(ctx, writeArgs)
	if err != nil {
		t.Fatalf("write tool execute failed: %v", err)
	}
	expectedOutput := fmt.Sprintf("成功向文件 '%s' 写入了 11 字节数据。", testFile)
	if output != expectedOutput {
		t.Errorf("expected output %q, got %q", expectedOutput, output)
	}

	// 2. 物理读取执行测试
	readArgs := fmt.Sprintf(`{"path":"%s"}`, testFile)
	content, err := r.Execute(ctx, readArgs)
	if err != nil {
		t.Fatalf("read tool execute failed: %v", err)
	}
	if content != "hello world" {
		t.Errorf("expected read content 'hello world', got %q", content)
	}

	// 3. 异常参数解析测试
	_, err = w.Execute(ctx, `{"path": 123}`)
	if err == nil {
		t.Error("expected error for invalid parameter types")
	}

	// 4. 读取不存在的文件测试
	_, err = r.Execute(ctx, `{"path":"/nonexistent/file/path.txt"}`)
	if err == nil {
		t.Error("expected error when reading nonexistent file")
	}
}
