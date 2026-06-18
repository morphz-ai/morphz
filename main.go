package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"morphz/config"
	"morphz/event"
	"morphz/llm"
	"morphz/memory"
	"morphz/orchestrator"
	"morphz/tool"
	"morphz/web"
)

func main() {
	// 1.0. 启动并守护本地 Rust 推理端 (TCP 127.0.0.1:8085)
	rustBinPath := "executor/target/release/executor"
	if _, err := os.Stat(rustBinPath); os.IsNotExist(err) {
		fmt.Println("⚙️ [Rust Executor] 未检测到 release 编译产物，启动就地编译 (cargo build --release)...")
		buildCmd := exec.Command("cargo", "build", "--release")
		buildCmd.Stdout = os.Stdout
		buildCmd.Stderr = os.Stderr
		if err := buildCmd.Run(); err != nil {
			fmt.Printf("⚠️ [Rust Executor] 自动就地编译失败: %v。请确保安装了 Rust 工具链，并在 executor 目录下手动编译。\n", err)
		} else {
			fmt.Println("⚙️ [Rust Executor] 编译成功！")
		}
	}

	var rustCmd *exec.Cmd
	if _, err := os.Stat(rustBinPath); err == nil {
		fmt.Println("⚙️ [Rust Executor] 启动本地推理守护进程...")
		rustCmd = exec.Command(rustBinPath)
		rustCmd.Stdout = os.Stdout
		rustCmd.Stderr = os.Stderr
		if err := rustCmd.Start(); err != nil {
			fmt.Printf("⚠️ [Rust Executor] 启动子进程失败: %v\n", err)
		} else {
			fmt.Println("⚙️ [Rust Executor] 守护进程启动成功，后台监听中。")
			defer func() {
				if rustCmd != nil && rustCmd.Process != nil {
					fmt.Println("⚙️ [Rust Executor] 正在停止本地推理守护进程...")
					_ = rustCmd.Process.Signal(os.Interrupt)
					_ = rustCmd.Wait()
				}
			}()
			// 给 Rust 进程 500ms 的冷启动建链时间
			time.Sleep(500 * time.Millisecond)
		}
	}

	// 1. 加载根目录下的 .env 环境变量 (如果不存在则忽略，退化为读取系统原生环境变量)
	_ = config.LoadEnv(".env")

	// 2. 从环境变量获取接口配置并实例化大模型客户端
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		fmt.Println("==================================================")
		fmt.Println("❌ 错误：未检测到 OPENAI_API_KEY 环境变量。")
		fmt.Println("   请在终端运行：export OPENAI_API_KEY=\"your_key_here\"")
		fmt.Println("==================================================")
		return
	}

	baseURL := os.Getenv("OPENAI_BASE_URL")
	modelName := os.Getenv("OPENAI_MODEL")
	if modelName == "" {
		modelName = "gpt-4o-mini"
	}

	fmt.Printf("[配置] 当前使用模型: %s\n", modelName)
	client := llm.NewOpenAIClient(apiKey, baseURL, modelName)

	// 3. 初始化事件总线与事件存储
	bus := event.NewInMemoryEventBus()
	store, err := memory.NewSqliteStore("morphz.db")
	if err != nil {
		fmt.Printf("❌ 初始化 SQLite 数据库失败: %v\n", err)
		return
	}
	defer store.Close()

	bus.SetErrorHandler(func(err error, ev event.Event) {
		fmt.Printf("\n⚠️ [事件总线错误警告] 事件ID: %s, 错误: %v\n", ev.ID, err)
	})

	// 4. 初始化工具注册表并注册本地文件工具
	registry := tool.NewRegistry()
	_ = registry.Register(&tool.WriteFileTool{})
	_ = registry.Register(&tool.ReadFileTool{})

	// 5. 初始化并启动 Orchestrator
	orc := orchestrator.NewOrchestrator(bus, store, client, registry)
	ctx := context.Background()

	if err := orc.Start(ctx); err != nil {
		fmt.Printf("❌ 启动 Orchestrator 失败: %v\n", err)
		return
	}

	// 5.5 启动大盘 API & WebSocket 服务器
	webSrv := web.NewServer(store, bus)
	if err := webSrv.Start("127.0.0.1:8080"); err != nil {
		fmt.Printf("❌ 启动大盘 Web 服务失败: %v\n", err)
		return
	}
	defer webSrv.Close()

	// 6. 启动控制台输入传感器 (Stdin Sensor)
	scanner := bufio.NewScanner(os.Stdin)
	fmt.Println("==================================================")
	fmt.Println("   Morphz Attempt Loop 运行成功！")
	fmt.Println("   已注册工具: write_file, read_file")
	fmt.Println("   您可以通过指令命令它做事情，例如：")
	fmt.Println("   > 帮我写一个 notes.txt 文件，内容为“Morphz Loop OK”")
	fmt.Println("==================================================")
	fmt.Print("> ")

	msgCounter := 0
	sessionID := fmt.Sprintf("session_%d", time.Now().Unix())

	for scanner.Scan() {
		text := strings.TrimSpace(scanner.Text())
		if text == "" {
			fmt.Print("> ")
			continue
		}
		if text == "exit" {
			fmt.Println("👋 退出 Morphz。")
			return
		}

		msgCounter++
		ev := event.NewEvent(
			fmt.Sprintf("msg_%d_%d", time.Now().UnixNano(), msgCounter),
			"User-Shafreeck",
			event.TypeUserMessage,
			"chat/user_message",
			map[string]interface{}{
				"session_id": sessionID,
				"text":       text,
			},
		)

		_ = bus.Publish(ctx, ev)

		// 稍微等待一下输出控制台的提示符，避免与大模型推理日志抢占
		time.Sleep(100 * time.Millisecond)
	}
}
