package memory

import (
	"context"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

// 保证 SqliteStore 隐式实现了 GraphStore 接口契约
var _ GraphStore = (*SqliteStore)(nil)

// 辅助方法：将 []float32 序列化为二进制 BLOB
func encodeEmbedding(vec []float32) []byte {
	if len(vec) == 0 {
		return nil
	}
	buf := make([]byte, len(vec)*4)
	for i, f := range vec {
		bits := math.Float32bits(f)
		binary.LittleEndian.PutUint32(buf[i*4:], bits)
	}
	return buf
}

// 辅助方法：从二进制 BLOB 反序列化为 []float32
func decodeEmbedding(buf []byte) []float32 {
	if len(buf) == 0 || len(buf)%4 != 0 {
		return nil
	}
	vec := make([]float32, len(buf)/4)
	for i := 0; i < len(vec); i++ {
		bits := binary.LittleEndian.Uint32(buf[i*4:])
		vec[i] = math.Float32frombits(bits)
	}
	return vec
}

// AddNode 物理写入或覆盖一个图节点
func (s *SqliteStore) AddNode(ctx context.Context, node Node) error {
	propertiesBytes, err := json.Marshal(node.Properties)
	if err != nil {
		return fmt.Errorf("failed to marshal node properties: %w", err)
	}

	embeddingBytes := encodeEmbedding(node.Embedding)

	isPerm := 0
	if node.IsPermanent {
		isPerm = 1
	}

	// 写入或更新时，将 last_accessed 默认设为当前 UTC 时间
	lastAccStr := time.Now().UTC().Format(time.RFC3339Nano)

	query := `INSERT INTO graph_nodes (id, label, properties, embedding, is_permanent, last_accessed) 
		VALUES (?, ?, ?, ?, ?, ?) 
		ON CONFLICT(id) DO UPDATE SET 
			label=excluded.label, 
			properties=excluded.properties, 
			embedding=coalesce(excluded.embedding, graph_nodes.embedding), 
			is_permanent=excluded.is_permanent, 
			last_accessed=excluded.last_accessed`
	_, err = s.db.ExecContext(ctx, query, node.ID, node.Label, string(propertiesBytes), embeddingBytes, isPerm, lastAccStr)
	if err != nil {
		return fmt.Errorf("failed to add graph node: %w", err)
	}

	return nil
}

// AddEdge 物理写入或覆盖一条边
func (s *SqliteStore) AddEdge(ctx context.Context, edge Edge) error {
	propertiesBytes, err := json.Marshal(edge.Properties)
	if err != nil {
		return fmt.Errorf("failed to marshal edge properties: %w", err)
	}

	isPerm := 0
	if edge.IsPermanent {
		isPerm = 1
	}

	lastAccStr := time.Now().UTC().Format(time.RFC3339Nano)

	query := `INSERT INTO graph_edges (id, from_node, to_node, type, properties, weight, is_permanent, last_accessed) 
		VALUES (?, ?, ?, ?, ?, ?, ?, ?) 
		ON CONFLICT(id) DO UPDATE SET 
			properties=excluded.properties, 
			weight=excluded.weight, 
			is_permanent=excluded.is_permanent, 
			last_accessed=excluded.last_accessed`
	_, err = s.db.ExecContext(ctx, query, edge.ID, edge.FromNode, edge.ToNode, edge.Type, string(propertiesBytes), edge.Weight, isPerm, lastAccStr)
	if err != nil {
		return fmt.Errorf("failed to add graph edge: %w", err)
	}
	return nil
}

// DeleteNode 删除顶点（由于开启了 PRAGMA foreign_keys=ON，此操作将级联删除与该点关联的所有边）
func (s *SqliteStore) DeleteNode(ctx context.Context, id string) error {
	query := `DELETE FROM graph_nodes WHERE id = ?`
	_, err := s.db.ExecContext(ctx, query, id)
	if err != nil {
		return fmt.Errorf("failed to delete graph node: %w", err)
	}
	return nil
}

// DeleteEdge 根据起点、终点和类型精确删除特定关系边
func (s *SqliteStore) DeleteEdge(ctx context.Context, fromNode, toNode, edgeType string) error {
	query := `DELETE FROM graph_edges WHERE from_node = ? AND to_node = ? AND type = ?`
	_, err := s.db.ExecContext(ctx, query, fromNode, toNode, edgeType)
	if err != nil {
		return fmt.Errorf("failed to delete graph edge: %w", err)
	}
	return nil
}

// GetNode 获取单节点数据，并自动更新该节点的 last_accessed 活跃时间戳
func (s *SqliteStore) GetNode(ctx context.Context, id string) (Node, error) {
	query := `SELECT id, label, properties, embedding, is_permanent, last_accessed FROM graph_nodes WHERE id = ?`
	row := s.db.QueryRowContext(ctx, query, id)

	var node Node
	var propertiesStr string
	var embeddingBytes []byte
	var isPerm int
	var lastAccessedStr string

	err := row.Scan(&node.ID, &node.Label, &propertiesStr, &embeddingBytes, &isPerm, &lastAccessedStr)
	if err != nil {
		if err == sql.ErrNoRows {
			return Node{}, fmt.Errorf("node not found: %s", id)
		}
		return Node{}, fmt.Errorf("failed to get graph node: %w", err)
	}

	if err := json.Unmarshal([]byte(propertiesStr), &node.Properties); err != nil {
		return Node{}, fmt.Errorf("failed to unmarshal node properties: %w", err)
	}

	node.Embedding = decodeEmbedding(embeddingBytes)
	node.IsPermanent = (isPerm == 1)
	if t, err := time.Parse(time.RFC3339Nano, lastAccessedStr); err == nil {
		node.LastAccessed = t
	} else if t, err := time.Parse(time.RFC3339, lastAccessedStr); err == nil {
		node.LastAccessed = t
	}

	// 自动更新活跃状态
	newLastAcc := time.Now().UTC().Format(time.RFC3339Nano)
	_, _ = s.db.ExecContext(ctx, `UPDATE graph_nodes SET last_accessed = ? WHERE id = ?`, newLastAcc, id)

	return node, nil
}

// GetNeighbors 获取目标节点的一跳（1-hop）邻居节点及相连的边，并自动更新读取到的节点和边的 last_accessed 活跃时间戳
func (s *SqliteStore) GetNeighbors(ctx context.Context, id string) ([]Node, []Edge, error) {
	// 1. 查询相关的边
	edgeQuery := `SELECT id, from_node, to_node, type, properties, weight, is_permanent, last_accessed FROM graph_edges WHERE from_node = ? OR to_node = ?`
	rows, err := s.db.QueryContext(ctx, edgeQuery, id, id)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to query neighbor edges: %w", err)
	}
	defer rows.Close()

	var edges []Edge
	for rows.Next() {
		var edge Edge
		var propertiesStr string
		var isPerm int
		var lastAccessedStr string
		err := rows.Scan(&edge.ID, &edge.FromNode, &edge.ToNode, &edge.Type, &propertiesStr, &edge.Weight, &isPerm, &lastAccessedStr)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to scan neighbor edge: %w", err)
		}
		if err := json.Unmarshal([]byte(propertiesStr), &edge.Properties); err != nil {
			return nil, nil, fmt.Errorf("failed to unmarshal edge properties: %w", err)
		}
		edge.IsPermanent = (isPerm == 1)
		if t, err := time.Parse(time.RFC3339Nano, lastAccessedStr); err == nil {
			edge.LastAccessed = t
		}
		edges = append(edges, edge)
	}

	// 2. 查询相关的所有邻居节点（排重）
	nodeQuery := `
	SELECT id, label, properties, embedding, is_permanent, last_accessed FROM graph_nodes WHERE id IN (
		SELECT to_node FROM graph_edges WHERE from_node = ? AND to_node != ?
		UNION
		SELECT from_node FROM graph_edges WHERE to_node = ? AND from_node != ?
	)`
	nodeRows, err := s.db.QueryContext(ctx, nodeQuery, id, id, id, id)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to query neighbor nodes: %w", err)
	}
	defer nodeRows.Close()

	var nodes []Node
	for nodeRows.Next() {
		var node Node
		var propertiesStr string
		var embeddingBytes []byte
		var isPerm int
		var lastAccessedStr string
		err := nodeRows.Scan(&node.ID, &node.Label, &propertiesStr, &embeddingBytes, &isPerm, &lastAccessedStr)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to scan neighbor node: %w", err)
		}
		if err := json.Unmarshal([]byte(propertiesStr), &node.Properties); err != nil {
			return nil, nil, fmt.Errorf("failed to unmarshal node properties: %w", err)
		}
		node.Embedding = decodeEmbedding(embeddingBytes)
		node.IsPermanent = (isPerm == 1)
		if t, err := time.Parse(time.RFC3339Nano, lastAccessedStr); err == nil {
			node.LastAccessed = t
		}
		nodes = append(nodes, node)
	}

	// 3. 自动将本次访问涉及到的点与边，更新 last_accessed 时间戳（突触激活）
	newLastAcc := time.Now().UTC().Format(time.RFC3339Nano)
	for _, edge := range edges {
		_, _ = s.db.ExecContext(ctx, `UPDATE graph_edges SET last_accessed = ? WHERE id = ?`, newLastAcc, edge.ID)
	}
	for _, node := range nodes {
		_, _ = s.db.ExecContext(ctx, `UPDATE graph_nodes SET last_accessed = ? WHERE id = ?`, newLastAcc, node.ID)
	}
	// 同时更新起始节点自己的时间戳
	_, _ = s.db.ExecContext(ctx, `UPDATE graph_nodes SET last_accessed = ? WHERE id = ?`, newLastAcc, id)

	return nodes, edges, nil
}

// QueryPath 利用 SQLite 递归公用表表达式（CTE）高性能检索多跳图路径
// 实现了【补强机制 ③】：在递归展开时采用窗口函数限制每个顶点的出度在 50 以内，防止大文件等频发实体引起的图关系膨胀与查询瘫痪
func (s *SqliteStore) QueryPath(ctx context.Context, startNodeID string, maxDepth int) ([]Node, []Edge, error) {
	// 1. 递归查询遍历到的所有顶点
	nodeQuery := `
	WITH RECURSIVE path(node_id, depth) AS (
		SELECT ?, 0
		UNION
		SELECT e.to_node, p.depth + 1
		FROM (
			-- 利用窗口函数对边关系进行排序，限制单个顶点向外发散的最大出度为 50，优先沿着连接权重（weight）最高的边扩展
			SELECT from_node, to_node, 
			       ROW_NUMBER() OVER(PARTITION BY from_node ORDER BY weight DESC) as rn
			FROM graph_edges
		) e
		JOIN path p ON e.from_node = p.node_id
		WHERE p.depth < ? AND e.rn <= 50
	)
	SELECT n.id, n.label, n.properties, n.embedding, n.is_permanent, n.last_accessed
	FROM path p
	JOIN graph_nodes n ON p.node_id = n.id;
	`
	nodeRows, err := s.db.QueryContext(ctx, nodeQuery, startNodeID, maxDepth)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to traverse graph nodes with CTE: %w", err)
	}
	defer nodeRows.Close()

	var nodes []Node
	for nodeRows.Next() {
		var node Node
		var propertiesStr string
		var embeddingBytes []byte
		var isPerm int
		var lastAccessedStr string
		err := nodeRows.Scan(&node.ID, &node.Label, &propertiesStr, &embeddingBytes, &isPerm, &lastAccessedStr)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to scan CTE node: %w", err)
		}
		if err := json.Unmarshal([]byte(propertiesStr), &node.Properties); err != nil {
			return nil, nil, fmt.Errorf("failed to unmarshal CTE node properties: %w", err)
		}
		node.Embedding = decodeEmbedding(embeddingBytes)
		node.IsPermanent = (isPerm == 1)
		if t, err := time.Parse(time.RFC3339Nano, lastAccessedStr); err == nil {
			node.LastAccessed = t
		}
		nodes = append(nodes, node)
	}

	// 2. 递归查询遍历到的顶点集合所包络的边
	edgeQuery := `
	WITH RECURSIVE path(node_id, depth) AS (
		SELECT ?, 0
		UNION
		SELECT e.to_node, p.depth + 1
		FROM (
			SELECT from_node, to_node, 
			       ROW_NUMBER() OVER(PARTITION BY from_node ORDER BY weight DESC) as rn
			FROM graph_edges
		) e
		JOIN path p ON e.from_node = p.node_id
		WHERE p.depth < ? AND e.rn <= 50
	)
	SELECT e.id, e.from_node, e.to_node, e.type, e.properties, e.weight, e.is_permanent, e.last_accessed
	FROM graph_edges e
	WHERE e.from_node IN (SELECT node_id FROM path)
	  AND e.to_node IN (SELECT node_id FROM path);
	`
	edgeRows, err := s.db.QueryContext(ctx, edgeQuery, startNodeID, maxDepth)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to traverse graph edges with CTE: %w", err)
	}
	defer edgeRows.Close()

	var edges []Edge
	for edgeRows.Next() {
		var edge Edge
		var propertiesStr string
		var isPerm int
		var lastAccessedStr string
		err := edgeRows.Scan(&edge.ID, &edge.FromNode, &edge.ToNode, &edge.Type, &propertiesStr, &edge.Weight, &isPerm, &lastAccessedStr)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to scan CTE edge: %w", err)
		}
		if err := json.Unmarshal([]byte(propertiesStr), &edge.Properties); err != nil {
			return nil, nil, fmt.Errorf("failed to unmarshal CTE edge properties: %w", err)
		}
		edge.IsPermanent = (isPerm == 1)
		if t, err := time.Parse(time.RFC3339Nano, lastAccessedStr); err == nil {
			edge.LastAccessed = t
		}
		edges = append(edges, edge)
	}

	// 3. 将所经过的点和边全部标记为活跃状态（突触加强）
	newLastAcc := time.Now().UTC().Format(time.RFC3339Nano)
	for _, edge := range edges {
		_, _ = s.db.ExecContext(ctx, `UPDATE graph_edges SET last_accessed = ? WHERE id = ?`, newLastAcc, edge.ID)
	}
	for _, node := range nodes {
		_, _ = s.db.ExecContext(ctx, `UPDATE graph_nodes SET last_accessed = ? WHERE id = ?`, newLastAcc, node.ID)
	}

	return nodes, edges, nil
}

// DecayAndPrune 批量衰减非 permanent 边权重，并物理清除“低权重且久未被访问（过期）”的边和孤立节点
// 实现了【补强机制 ①】永久保护，和【补强机制 ②】基于 last_accessed 的延迟遗忘
func (s *SqliteStore) DecayAndPrune(ctx context.Context, decayFactor float64, threshold float64, inactiveSeconds int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to start decay transaction: %w", err)
	}
	defer func() {
		_ = tx.Rollback()
	}()

	// 1. 突触弱化：指数衰减所有非永久保存（is_permanent = 0）的边关系权重
	decaySQL := `UPDATE graph_edges SET weight = weight * ? WHERE is_permanent = 0`
	if _, err := tx.ExecContext(ctx, decaySQL, decayFactor); err != nil {
		return fmt.Errorf("failed to execute edges weight decay: %w", err)
	}

	// 2. 延迟清理：物理清除“权重低于阈值” 且 “最后访问时间超出静默秒数” 的非永久边
	cutoffTime := time.Now().UTC().Add(-time.Duration(inactiveSeconds) * time.Second).Format(time.RFC3339Nano)
	pruneEdgesSQL := `DELETE FROM graph_edges WHERE is_permanent = 0 AND weight < ? AND last_accessed < ?`
	if _, err := tx.ExecContext(ctx, pruneEdgesSQL, threshold, cutoffTime); err != nil {
		return fmt.Errorf("failed to prune expired weak edges: %w", err)
	}

	// 3. 孤立节点物理擦除：当非永久节点久未访问，且全图已无任何边与之相连时，自动物理删除该垃圾概念节点
	pruneNodesSQL := `
	DELETE FROM graph_nodes 
	WHERE is_permanent = 0 
	  AND last_accessed < ? 
	  AND id NOT IN (
		  SELECT from_node FROM graph_edges
		  UNION
		  SELECT to_node FROM graph_edges
	  )
	`
	if _, err := tx.ExecContext(ctx, pruneNodesSQL, cutoffTime); err != nil {
		return fmt.Errorf("failed to prune orphan nodes: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit decay transaction: %w", err)
	}

	return nil
}

// SearchNodesByText 根据文本模糊匹配节点 ID（适用于通过用户输入内容模糊匹配关联实体）
func (s *SqliteStore) SearchNodesByText(ctx context.Context, text string) ([]Node, error) {
	// 将文本转换为小写以实现 Case-insensitive 匹配
	lowerText := strings.ToLower(text)

	query := `SELECT id, label, properties, embedding, is_permanent, last_accessed FROM graph_nodes WHERE ? LIKE '%' || id || '%'`
	rows, err := s.db.QueryContext(ctx, query, lowerText)
	if err != nil {
		return nil, fmt.Errorf("failed to search nodes by text: %w", err)
	}
	defer rows.Close()

	var nodes []Node
	for rows.Next() {
		var node Node
		var propertiesStr string
		var embeddingBytes []byte
		var isPerm int
		var lastAccessedStr string
		err := rows.Scan(&node.ID, &node.Label, &propertiesStr, &embeddingBytes, &isPerm, &lastAccessedStr)
		if err != nil {
			return nil, fmt.Errorf("failed to scan node: %w", err)
		}
		if err := json.Unmarshal([]byte(propertiesStr), &node.Properties); err != nil {
			return nil, fmt.Errorf("failed to unmarshal properties: %w", err)
		}
		node.Embedding = decodeEmbedding(embeddingBytes)
		node.IsPermanent = (isPerm == 1)
		if t, err := time.Parse(time.RFC3339Nano, lastAccessedStr); err == nil {
			node.LastAccessed = t
		}
		nodes = append(nodes, node)
	}
	return nodes, nil
}

// GetAllNodesAndEdges 获取图数据库中的全部节点和边数据，供前端全量渲染使用
func (s *SqliteStore) GetAllNodesAndEdges(ctx context.Context) ([]Node, []Edge, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// 1. 查询所有节点
	nodeQuery := `SELECT id, label, properties, embedding, is_permanent, last_accessed FROM graph_nodes`
	nodeRows, err := s.db.QueryContext(ctx, nodeQuery)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to query all nodes: %w", err)
	}
	defer nodeRows.Close()

	var nodes []Node
	for nodeRows.Next() {
		var node Node
		var propertiesStr string
		var embeddingBytes []byte
		var isPerm int
		var lastAccessedStr string
		err := nodeRows.Scan(&node.ID, &node.Label, &propertiesStr, &embeddingBytes, &isPerm, &lastAccessedStr)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to scan node: %w", err)
		}
		if err := json.Unmarshal([]byte(propertiesStr), &node.Properties); err != nil {
			return nil, nil, fmt.Errorf("failed to unmarshal node properties: %w", err)
		}
		node.Embedding = decodeEmbedding(embeddingBytes)
		node.IsPermanent = (isPerm == 1)
		if t, err := time.Parse(time.RFC3339Nano, lastAccessedStr); err == nil {
			node.LastAccessed = t
		}
		nodes = append(nodes, node)
	}

	// 2. 查询所有边
	edgeQuery := `SELECT id, from_node, to_node, type, properties, weight, is_permanent, last_accessed FROM graph_edges`
	edgeRows, err := s.db.QueryContext(ctx, edgeQuery)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to query all edges: %w", err)
	}
	defer edgeRows.Close()

	var edges []Edge
	for edgeRows.Next() {
		var edge Edge
		var propertiesStr string
		var isPerm int
		var lastAccessedStr string
		err := edgeRows.Scan(&edge.ID, &edge.FromNode, &edge.ToNode, &edge.Type, &propertiesStr, &edge.Weight, &isPerm, &lastAccessedStr)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to scan edge: %w", err)
		}
		if err := json.Unmarshal([]byte(propertiesStr), &edge.Properties); err != nil {
			return nil, nil, fmt.Errorf("failed to unmarshal edge properties: %w", err)
		}
		edge.IsPermanent = (isPerm == 1)
		if t, err := time.Parse(time.RFC3339Nano, lastAccessedStr); err == nil {
			edge.LastAccessed = t
		}
		edges = append(edges, edge)
	}

	return nodes, edges, nil
}

// SearchNodesByEmbedding 在已有的图节点中进行向量余弦相似度检索，召回 topK 个相似节点
func (s *SqliteStore) SearchNodesByEmbedding(ctx context.Context, queryEmbedding []float32, topK int) ([]Node, error) {
	if len(queryEmbedding) == 0 {
		return nil, nil
	}

	// 1. 查询所有带有 Embedding 的节点
	query := `SELECT id, label, properties, embedding, is_permanent, last_accessed FROM graph_nodes WHERE embedding IS NOT NULL`
	
	s.mu.Lock()
	rows, err := s.db.QueryContext(ctx, query)
	s.mu.Unlock()
	if err != nil {
		return nil, fmt.Errorf("failed to query nodes for embedding search: %w", err)
	}
	defer rows.Close()

	type nodeSim struct {
		node Node
		sim  float32
	}
	var candidates []nodeSim

	for rows.Next() {
		var node Node
		var propertiesStr string
		var embeddingBytes []byte
		var isPerm int
		var lastAccessedStr string
		err := rows.Scan(&node.ID, &node.Label, &propertiesStr, &embeddingBytes, &isPerm, &lastAccessedStr)
		if err != nil {
			return nil, fmt.Errorf("failed to scan node: %w", err)
		}
		if err := json.Unmarshal([]byte(propertiesStr), &node.Properties); err != nil {
			return nil, fmt.Errorf("failed to unmarshal properties: %w", err)
		}
		node.Embedding = decodeEmbedding(embeddingBytes)
		node.IsPermanent = (isPerm == 1)
		if t, err := time.Parse(time.RFC3339Nano, lastAccessedStr); err == nil {
			node.LastAccessed = t
		}

		if len(node.Embedding) == 0 {
			continue
		}

		// 计算余弦相似度
		sim := cosineSimilarity(queryEmbedding, node.Embedding)
		// 根据维度动态设定阈值。本地 N-Gram Hashing 维度为 256，相似度一般在 0.5 左右，降低阈值至 0.45。
		threshold := float32(0.7)
		if len(queryEmbedding) == 256 {
			threshold = 0.45
		}
		if sim >= threshold {
			candidates = append(candidates, nodeSim{node: node, sim: sim})
		}
	}

	// 2. 按相似度由高到低排序
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].sim > candidates[j].sim
	})

	// 3. 限制返回的 topK 个节点
	n := len(candidates)
	if n > topK {
		n = topK
	}

	result := make([]Node, n)
	for i := 0; i < n; i++ {
		result[i] = candidates[i].node
	}

	return result, nil
}

func cosineSimilarity(a, b []float32) float32 {
	if len(a) != len(b) || len(a) == 0 {
		return 0
	}
	var dotProduct, normA, normB float64
	for i := 0; i < len(a); i++ {
		dotProduct += float64(a[i] * b[i])
		normA += float64(a[i] * a[i])
		normB += float64(b[i] * b[i])
	}
	if normA == 0 || normB == 0 {
		return 0
	}
	return float32(dotProduct / (math.Sqrt(normA) * math.Sqrt(normB)))
}
