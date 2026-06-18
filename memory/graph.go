package memory

import (
	"context"
	"time"
)

// Node 顶点定义，代表实体或概念
type Node struct {
	ID           string                 `json:"id"`
	Label        string                 `json:"label"`      // Person, File, Concept, Tool 等
	Properties   map[string]interface{} `json:"properties"` // JSON 格式属性
	Embedding    []float32              `json:"embedding"`  // 预留的嵌入向量
	IsPermanent  bool                   `json:"is_permanent"`
	LastAccessed time.Time              `json:"last_accessed"`
}

// Edge 边定义，代表实体间关系
type Edge struct {
	ID           string                 `json:"id"`
	FromNode     string                 `json:"from_node"`
	ToNode       string                 `json:"to_node"`
	Type         string                 `json:"type"`       // depends_on, created_by, owns 等
	Properties   map[string]interface{} `json:"properties"` // JSON 属性
	Weight       float64                `json:"weight"`     // 连接权重
	IsPermanent  bool                   `json:"is_permanent"`
	LastAccessed time.Time              `json:"last_accessed"`
}

// GraphStore 定义了图谱记忆物理读写的核心接口契约
type GraphStore interface {
	// 写入接口
	AddNode(ctx context.Context, node Node) error
	AddEdge(ctx context.Context, edge Edge) error
	DeleteNode(ctx context.Context, id string) error
	DeleteEdge(ctx context.Context, fromNode, toNode, edgeType string) error

	// 单节点及邻居查询
	GetNode(ctx context.Context, id string) (Node, error)
	GetNeighbors(ctx context.Context, id string) ([]Node, []Edge, error)
	SearchNodesByText(ctx context.Context, text string) ([]Node, error)
	SearchNodesByEmbedding(ctx context.Context, queryEmbedding []float32, topK int) ([]Node, error)
	// 全量图数据查询
	GetAllNodesAndEdges(ctx context.Context) ([]Node, []Edge, error)

	// 多跳递归图遍历（拓扑检索的核心）
	QueryPath(ctx context.Context, startNodeID string, maxDepth int) ([]Node, []Edge, error)

	// DecayAndPrune 批量衰减非 permanent 的边权重，并物理清除“低权重且久未被访问”的过期边和孤立节点
	// - decayFactor: 衰减系数（如 0.9，每次扣减 10%）
	// - threshold: 触发删除的权重阈值下限（如 0.1）
	// - inactiveSeconds: 判定为久未访问的静默期秒数
	DecayAndPrune(ctx context.Context, decayFactor float64, threshold float64, inactiveSeconds int64) error
}
