package memory

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestSqliteStore_GraphBasicOperations(t *testing.T) {
	store, err := NewSqliteStore(":memory:")
	if err != nil {
		t.Fatalf("failed to init sqlite store: %v", err)
	}
	defer store.Close()

	ctx := context.Background()

	// 1. 创建并添加节点
	n1 := Node{
		ID:    "n_user",
		Label: "Person",
		Properties: map[string]interface{}{
			"name": "Shafreeck",
			"age":  float64(30),
		},
		Embedding:   []float32{0.1, 0.2, -0.3, 0.4},
		IsPermanent: true,
	}

	n2 := Node{
		ID:    "n_tool",
		Label: "Tool",
		Properties: map[string]interface{}{
			"name": "write_file",
		},
		Embedding: []float32{0.9, -0.8},
	}

	if err := store.AddNode(ctx, n1); err != nil {
		t.Fatalf("failed to add n1: %v", err)
	}
	if err := store.AddNode(ctx, n2); err != nil {
		t.Fatalf("failed to add n2: %v", err)
	}

	// 2. 读取节点并断言验证（读取会自动更新 last_accessed，此处验证读取成功即可）
	gotN1, err := store.GetNode(ctx, "n_user")
	if err != nil {
		t.Fatalf("failed to get n1: %v", err)
	}
	if gotN1.Label != "Person" || gotN1.Properties["name"] != "Shafreeck" {
		t.Errorf("got invalid node attributes: %+v", gotN1)
	}
	if !gotN1.IsPermanent {
		t.Errorf("expected is_permanent to be true for n_user")
	}

	// 3. 写入边
	edge := Edge{
		ID:       "e_1",
		FromNode: "n_user",
		ToNode:   "n_tool",
		Type:     "executes",
		Properties: map[string]interface{}{
			"times": float64(5),
		},
		Weight: 1.5,
	}
	if err := store.AddEdge(ctx, edge); err != nil {
		t.Fatalf("failed to add edge: %v", err)
	}

	// 4. 查询一跳邻居关系
	neighbors, edges, err := store.GetNeighbors(ctx, "n_user")
	if err != nil {
		t.Fatalf("failed to get neighbors: %v", err)
	}
	if len(neighbors) != 1 || neighbors[0].ID != "n_tool" {
		t.Errorf("expected neighbor 'n_tool', got: %v", neighbors)
	}
	if len(edges) != 1 || edges[0].ID != "e_1" {
		t.Errorf("expected edge 'e_1', got: %v", edges)
	}

	// 4.5 测试全量查询
	allNodes, allEdges, err := store.GetAllNodesAndEdges(ctx)
	if err != nil {
		t.Fatalf("failed to get all nodes and edges: %v", err)
	}
	if len(allNodes) != 2 || len(allEdges) != 1 {
		t.Errorf("expected 2 nodes and 1 edge, got %d nodes and %d edges", len(allNodes), len(allEdges))
	}

	// 5. 校验外键级联删除 ON DELETE CASCADE
	if err := store.DeleteNode(ctx, "n_user"); err != nil {
		t.Fatalf("failed to delete node: %v", err)
	}

	_, gotEdges, err := store.GetNeighbors(ctx, "n_tool")
	if err != nil {
		t.Fatalf("failed to get neighbors of n_tool: %v", err)
	}
	if len(gotEdges) != 0 {
		t.Errorf("cascade delete failed: edge still exists: %v", gotEdges)
	}
}

func TestSqliteStore_PermanentMemoryProtection(t *testing.T) {
	store, err := NewSqliteStore(":memory:")
	if err != nil {
		t.Fatalf("failed to init store: %v", err)
	}
	defer store.Close()

	ctx := context.Background()

	// 写入节点
	_ = store.AddNode(ctx, Node{ID: "A", Label: "Job", Properties: map[string]interface{}{}})
	_ = store.AddNode(ctx, Node{ID: "B", Label: "Job", Properties: map[string]interface{}{}})
	_ = store.AddNode(ctx, Node{ID: "C", Label: "Job", Properties: map[string]interface{}{}})

	// 写入边
	// e1: 永久边 (IsPermanent = true)
	e1 := Edge{ID: "e1", FromNode: "A", ToNode: "B", Type: "depends", Weight: 1.0, IsPermanent: true}
	// e2: 非永久边 (IsPermanent = false)
	e2 := Edge{ID: "e2", FromNode: "B", ToNode: "C", Type: "depends", Weight: 1.0, IsPermanent: false}

	_ = store.AddEdge(ctx, e1)
	_ = store.AddEdge(ctx, e2)

	// 模拟将最后访问时间改为 10 天前，使其进入可被清理的静默期
	pastTime := time.Now().UTC().Add(-240 * time.Hour).Format(time.RFC3339Nano)
	_, _ = store.db.Exec(`UPDATE graph_edges SET last_accessed = ?`, pastTime)

	// 执行 DecayAndPrune：衰减因子 0.5，删除权重阈值 0.6，过期判定时长为 1 小时 (3600 秒)
	// - 永久边 e1 权重应该毫发未损 (保持 1.0)，且不被删除
	// - 非永久边 e2 权重将降为 0.5，且由于 0.5 < 0.6 并且过期，应被物理删除
	err = store.DecayAndPrune(ctx, 0.5, 0.6, 3600)
	if err != nil {
		t.Fatalf("DecayAndPrune failed: %v", err)
	}

	// 检索边，验证是否符合预期
	_, gotEdges, err := store.GetNeighbors(ctx, "A")
	if err != nil {
		t.Fatalf("failed to get neighbors of A: %v", err)
	}

	if len(gotEdges) != 1 || gotEdges[0].ID != "e1" {
		t.Errorf("expected only permanent edge e1 to remain, got: %v", gotEdges)
	}

	if gotEdges[0].Weight != 1.0 {
		t.Errorf("expected permanent edge weight to remain 1.0, got %f", gotEdges[0].Weight)
	}
}

func TestSqliteStore_DelayedForget(t *testing.T) {
	store, err := NewSqliteStore(":memory:")
	if err != nil {
		t.Fatalf("failed to init store: %v", err)
	}
	defer store.Close()

	ctx := context.Background()

	_ = store.AddNode(ctx, Node{ID: "A", Label: "Concept", Properties: map[string]interface{}{}})
	_ = store.AddNode(ctx, Node{ID: "B", Label: "Concept", Properties: map[string]interface{}{}})

	// 写入一条极低权重、非永久边 (weight = 0.05, 触发删除阈值设为 0.1)
	e := Edge{ID: "e_weak", FromNode: "A", ToNode: "B", Type: "rel", Weight: 0.05, IsPermanent: false}
	_ = store.AddEdge(ctx, e)

	// 情况一：最后访问时间是当前（刚被读取过）。虽然权重极低，但不应当被清除
	err = store.DecayAndPrune(ctx, 1.0, 0.1, 3600) // 1 小时过期
	if err != nil {
		t.Fatalf("DecayAndPrune error: %v", err)
	}

	_, gotEdges, _ := store.GetNeighbors(ctx, "A")
	if len(gotEdges) != 1 {
		t.Errorf("expected weak but recently accessed edge to be protected, but it was deleted")
	}

	// 情况二：人工修改最后访问时间为 2 小时前，使其静默过期
	twoHoursAgo := time.Now().UTC().Add(-2 * time.Hour).Format(time.RFC3339Nano)
	_, _ = store.db.Exec(`UPDATE graph_edges SET last_accessed = ? WHERE id = 'e_weak'`, twoHoursAgo)

	// 再次执行，此时由于既是弱权重又已过期，应当被删除
	err = store.DecayAndPrune(ctx, 1.0, 0.1, 3600)
	if err != nil {
		t.Fatalf("DecayAndPrune error: %v", err)
	}

	_, gotEdges, _ = store.GetNeighbors(ctx, "A")
	if len(gotEdges) != 0 {
		t.Errorf("expected weak and expired edge to be pruned, but it remains")
	}
}

func TestSqliteStore_OutDegreePruning(t *testing.T) {
	store, err := NewSqliteStore(":memory:")
	if err != nil {
		t.Fatalf("failed to init store: %v", err)
	}
	defer store.Close()

	ctx := context.Background()

	_ = store.AddNode(ctx, Node{ID: "core", Label: "Hub", Properties: map[string]interface{}{}})

	// 连出 60 个节点。
	// 第 1-50 个叶子节点：权重为 2.0
	// 第 51-60 个叶子节点：权重为 0.5
	for i := 1; i <= 60; i++ {
		leafID := fmt.Sprintf("leaf_%d", i)
		_ = store.AddNode(ctx, Node{ID: leafID, Label: "Leaf", Properties: map[string]interface{}{}})

		weight := 2.0
		if i > 50 {
			weight = 0.5
		}

		edge := Edge{
			ID:       fmt.Sprintf("e_%d", i),
			FromNode: "core",
			ToNode:   leafID,
			Type:     "depends",
			Weight:   weight,
		}
		_ = store.AddEdge(ctx, edge)
	}

	// 从 core 开始查询，最大深度 1
	// 我们的 CTE 窗口函数设定 rn <= 50，所以只应返回权重前 50 名关联的叶子节点与边
	gotNodes, gotEdges, err := store.QueryPath(ctx, "core", 1)
	if err != nil {
		t.Fatalf("QueryPath error: %v", err)
	}

	// 返回节点总数 = core(起点) + 50个高权重叶子节点 = 51
	if len(gotNodes) != 51 {
		t.Errorf("expected 51 traversed nodes (1 core + 50 leaves), got %d", len(gotNodes))
	}

	// 返回的边数应该恰好被截断为 50 条
	if len(gotEdges) != 50 {
		t.Errorf("expected 50 traversed edges, got %d", len(gotEdges))
	}

	// 验证所有返回的边，其权重是否都是 2.0 (权重 0.5 的低度边应该全部被截断过滤)
	for _, edge := range gotEdges {
		if edge.Weight != 2.0 {
			t.Errorf("edge %s with weight %f was traversed, expected only weight 2.0", edge.ID, edge.Weight)
		}
	}
}

func TestSqliteStore_GraphConcurrency(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "morphz_sqlite_graph_test")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	dbPath := filepath.Join(tempDir, "graph_test.db")
	store, err := NewSqliteStore(dbPath)
	if err != nil {
		t.Fatalf("failed to init store: %v", err)
	}
	defer store.Close()

	ctx := context.Background()
	var wg sync.WaitGroup
	concurrency := 10
	operations := 20

	var writeMu sync.Mutex

	coreNode := Node{ID: "core", Label: "Hub", Properties: map[string]interface{}{}}
	_ = store.AddNode(ctx, coreNode)

	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func(routineID int) {
			defer wg.Done()
			for j := 0; j < operations; j++ {
				nID := fmt.Sprintf("node_%d_%d", routineID, j)
				eID := fmt.Sprintf("edge_%d_%d", routineID, j)

				n := Node{
					ID:         nID,
					Label:      "Leaf",
					Properties: map[string]interface{}{"val": j},
				}
				e := Edge{
					ID:       eID,
					FromNode: "core",
					ToNode:   nID,
					Type:     "connects",
					Properties: map[string]interface{}{},
					Weight:   1.0,
				}

				writeMu.Lock()
				_ = store.AddNode(ctx, n)
				_ = store.AddEdge(ctx, e)
				writeMu.Unlock()
			}
		}(i)
	}

	wg.Wait()

	neighbors, _, err := store.GetNeighbors(ctx, "core")
	if err != nil {
		t.Fatalf("failed to query neighbors: %v", err)
	}

	expectedCount := concurrency * operations
	if len(neighbors) != expectedCount {
		t.Errorf("expected %d nodes connected to core, got %d", expectedCount, len(neighbors))
	}
}

func TestSqliteStore_SearchNodesByEmbedding(t *testing.T) {
	store, err := NewSqliteStore(":memory:")
	if err != nil {
		t.Fatalf("failed to init store: %v", err)
	}
	defer store.Close()

	ctx := context.Background()

	// 1. 写入测试节点
	nA := Node{
		ID:         "node_a",
		Label:      "Concept",
		Properties: map[string]interface{}{"name": "sqlite_lock"},
		Embedding:  []float32{1.0, 0.0, 0.0},
	}
	nB := Node{
		ID:         "node_b",
		Label:      "Concept",
		Properties: map[string]interface{}{"name": "database_lock"},
		Embedding:  []float32{0.7071, 0.7071, 0.0},
	}
	nC := Node{
		ID:         "node_c",
		Label:      "Concept",
		Properties: map[string]interface{}{"name": "golang_channel"},
		Embedding:  []float32{0.0, 1.0, 0.0},
	}

	_ = store.AddNode(ctx, nA)
	_ = store.AddNode(ctx, nB)
	_ = store.AddNode(ctx, nC)

	// 2. 传入 query 向量
	queryVec := []float32{1.0, 0.1, 0.0}
	
	nodes, err := store.SearchNodesByEmbedding(ctx, queryVec, 5)
	if err != nil {
		t.Fatalf("SearchNodesByEmbedding failed: %v", err)
	}

	// A 相似度 0.995，B 相似度 0.774，C 相似度 0.099 (C 应被相似度阈值 0.7 过滤)
	if len(nodes) != 2 {
		t.Fatalf("expected 2 nodes, got %d", len(nodes))
	}

	if nodes[0].ID != "node_a" {
		t.Errorf("expected nodes[0] to be node_a (highest similarity), got %s", nodes[0].ID)
	}
	if nodes[1].ID != "node_b" {
		t.Errorf("expected nodes[1] to be node_b, got %s", nodes[1].ID)
	}

	// topK = 1 截断
	nodesLimit, err := store.SearchNodesByEmbedding(ctx, queryVec, 1)
	if err != nil {
		t.Fatalf("SearchNodesByEmbedding failed: %v", err)
	}
	if len(nodesLimit) != 1 || nodesLimit[0].ID != "node_a" {
		t.Errorf("expected topK=1 to return only node_a, got %v", nodesLimit)
	}
}
