package web

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"

	"morphz/event"
	"morphz/memory"

	"golang.org/x/net/websocket"
)

// Hub 管理所有的 WebSocket 连接
type Hub struct {
	mu      sync.Mutex
	clients map[*websocket.Conn]bool
}

func NewHub() *Hub {
	return &Hub{
		clients: make(map[*websocket.Conn]bool),
	}
}

func (h *Hub) Register(conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[conn] = true
}

func (h *Hub) Unregister(conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.clients, conn)
}

func (h *Hub) Broadcast(msg interface{}) {
	h.mu.Lock()
	defer h.mu.Unlock()

	data, err := json.Marshal(msg)
	if err != nil {
		return
	}

	for conn := range h.clients {
		_ = websocket.Message.Send(conn, string(data))
	}
}

type Server struct {
	store      memory.EventStore
	bus        event.Bus
	hub        *Hub
	httpServer *http.Server
	listener   net.Listener
}

func NewServer(store memory.EventStore, bus event.Bus) *Server {
	return &Server{
		store: store,
		bus:   bus,
		hub:   NewHub(),
	}
}

func (s *Server) Start(addr string) error {
	mux := http.NewServeMux()

	// 1. CORS 中间件，方便 Next.js/Vite 在不同端口访问
	corsHandler := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			if r.Method == "OPTIONS" {
				w.WriteHeader(http.StatusOK)
				return
			}
			h(w, r)
		}
	}

	// 2. 注册 REST API：全量获取顶点与边
	mux.HandleFunc("/api/graph", corsHandler(s.handleGetGraph))

	// 3. 注册 WebSocket 接口
	mux.Handle("/ws", websocket.Handler(s.handleWebSocket))

	// 4. 注册 EventBus 拦截订阅：将所有事件实时推送至大盘
	_, err := s.bus.Subscribe("*", func(ctx context.Context, ev event.Event) error {
		// 向 WebSocket 客户端广播事件
		s.hub.Broadcast(ev)
		return nil
	})
	if err != nil {
		return fmt.Errorf("web server failed to subscribe to event bus: %w", err)
	}

	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	s.listener = listener

	s.httpServer = &http.Server{
		Handler: mux,
	}

	go func() {
		_ = s.httpServer.Serve(listener)
	}()

	fmt.Printf("🌐 [Web Server] Dashboard API Server 启动成功，监听地址: http://%s\n", listener.Addr().String())
	return nil
}

func (s *Server) Close() error {
	if s.httpServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = s.httpServer.Shutdown(ctx)
	}
	return nil
}

func (s *Server) Addr() string {
	if s.listener != nil {
		return s.listener.Addr().String()
	}
	return ""
}

func (s *Server) handleGetGraph(w http.ResponseWriter, r *http.Request) {
	graphStore, ok := s.store.(memory.GraphStore)
	if !ok {
		http.Error(w, "store does not implement GraphStore", http.StatusInternalServerError)
		return
	}

	nodes, edges, err := graphStore.GetAllNodesAndEdges(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	resp := map[string]interface{}{
		"nodes": nodes,
		"edges": edges,
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func (s *Server) handleWebSocket(ws *websocket.Conn) {
	s.hub.Register(ws)
	defer func() {
		s.hub.Unregister(ws)
		_ = ws.Close()
	}()

	// 首次连接时，也可以主动向客户端推送一份当前全量图谱，让客户端能立刻渲染出来
	graphStore, ok := s.store.(memory.GraphStore)
	if ok {
		nodes, edges, err := graphStore.GetAllNodesAndEdges(context.Background())
		if err == nil {
			initMsg := map[string]interface{}{
				"type":  "init_graph",
				"nodes": nodes,
				"edges": edges,
			}
			data, err := json.Marshal(initMsg)
			if err == nil {
				_ = websocket.Message.Send(ws, string(data))
			}
		}
	}

	// 维持连接
	var reply string
	for {
		if err := websocket.Message.Receive(ws, &reply); err != nil {
			break
		}
	}
}
