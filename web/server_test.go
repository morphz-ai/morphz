package web

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"morphz/event"
	"morphz/memory"

	"golang.org/x/net/websocket"
)

func TestServer_GraphAPIAndWebSocket(t *testing.T) {
	// 1. 初始化内存数据库和事件总线
	store, err := memory.NewSqliteStore(":memory:")
	if err != nil {
		t.Fatalf("failed to init store: %v", err)
	}
	defer store.Close()

	bus := event.NewInMemoryEventBus()

	// 预先写入两个测试节点和一条边
	ctx := context.Background()
	var graphStore memory.GraphStore = store
	_ = graphStore.AddNode(ctx, memory.Node{ID: "n1", Label: "Person", Properties: map[string]interface{}{"name": "User"}})
	_ = graphStore.AddNode(ctx, memory.Node{ID: "n2", Label: "Tool", Properties: map[string]interface{}{"name": "Tool"}})
	_ = graphStore.AddEdge(ctx, memory.Edge{ID: "e1", FromNode: "n1", ToNode: "n2", Type: "USES", Properties: map[string]interface{}{}})

	// 2. 启动本地 Web 服务器（端口设为 0 以获取随机可用端口）
	srv := NewServer(store, bus)
	if err := srv.Start("127.0.0.1:0"); err != nil {
		t.Fatalf("failed to start server: %v", err)
	}
	defer srv.Close()

	addr := srv.Addr()
	t.Logf("Web test server is listening on: %s", addr)

	// 3. 测试 HTTP /api/graph 接口
	resp, err := http.Get("http://" + addr + "/api/graph")
	if err != nil {
		t.Fatalf("HTTP request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("Expected status 200, got %d", resp.StatusCode)
	}

	body, _ := io.ReadAll(resp.Body)
	var graphData struct {
		Nodes []memory.Node `json:"nodes"`
		Edges []memory.Edge `json:"edges"`
	}
	if err := json.Unmarshal(body, &graphData); err != nil {
		t.Fatalf("Failed to parse JSON response: %v", err)
	}

	if len(graphData.Nodes) != 2 || len(graphData.Edges) != 1 {
		t.Errorf("Expected 2 nodes and 1 edge, got %d nodes and %d edges", len(graphData.Nodes), len(graphData.Edges))
	}

	// 4. 测试 WebSocket 实时事件推送
	wsURL := "ws://" + addr + "/ws"
	origin := "http://localhost/"
	ws, err := websocket.Dial(wsURL, "", origin)
	if err != nil {
		t.Fatalf("WebSocket connection failed: %v", err)
	}
	defer ws.Close()

	// 4.1 首次连接后，WebSocket 会自动推送初始化 init_graph 数据
	var initMsgStr string
	err = websocket.Message.Receive(ws, &initMsgStr)
	if err != nil {
		t.Fatalf("Failed to receive init message: %v", err)
	}
	if !strings.Contains(initMsgStr, "init_graph") {
		t.Errorf("Expected first message to be init_graph, got: %s", initMsgStr)
	}

	// 4.2 往 EventBus 里发布一个事件，验证广播机制
	testEvent := event.NewEvent("test_ev_123", "Tester", event.TypeUserMessage, "chat/user_message", map[string]interface{}{
		"text": "WebSocket Broadcast Test",
	})

	if err := bus.Publish(ctx, testEvent); err != nil {
		t.Fatalf("Failed to publish event: %v", err)
	}

	// 等待 WebSocket 接收事件推送，设置 1 秒超时
	done := make(chan bool, 1)
	go func() {
		var receivedStr string
		err := websocket.Message.Receive(ws, &receivedStr)
		if err == nil && strings.Contains(receivedStr, "test_ev_123") {
			done <- true
		} else {
			t.Logf("Received unexpected message or error: %v, msg: %s", err, receivedStr)
		}
	}()

	select {
	case <-done:
		t.Log("WebSocket event broadcast successfully verified!")
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for WebSocket event broadcast")
	}
}
