package memory

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"morphz/event"

	_ "modernc.org/sqlite"
)

// SqliteStore 基于 SQLite 物理文件的持久化 EventStore 实现
type SqliteStore struct {
	mu sync.Mutex
	db *sql.DB
}

// NewSqliteStore 构造函数，初始化并自动运行建表与索引 DDL
func NewSqliteStore(dbPath string) (*SqliteStore, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open sqlite database: %w", err)
	}

	// 限制 SQLite 的最大连接数为 1，规避 database is locked，且在 :memory: 下共享同一个内存库
	db.SetMaxOpenConns(1)

	// 启用外键约束，以支持 ON DELETE CASCADE 级联删除
	if _, err := db.Exec("PRAGMA foreign_keys = ON;"); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to enable foreign keys pragma: %w", err)
	}

	// 执行建表 DDL，包含事件表与图谱表
	ddl := `
	CREATE TABLE IF NOT EXISTS events (
		id TEXT PRIMARY KEY,
		timestamp TEXT NOT NULL,
		actor TEXT NOT NULL,
		type TEXT NOT NULL,
		topic TEXT NOT NULL,
		payload TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
	CREATE INDEX IF NOT EXISTS idx_events_topic ON events(topic);

	CREATE TABLE IF NOT EXISTS graph_nodes (
		id TEXT PRIMARY KEY,
		label TEXT NOT NULL,
		properties TEXT NOT NULL,
		embedding BLOB,
		is_permanent INTEGER DEFAULT 0,
		last_accessed TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS graph_edges (
		id TEXT PRIMARY KEY,
		from_node TEXT NOT NULL,
		to_node TEXT NOT NULL,
		type TEXT NOT NULL,
		properties TEXT NOT NULL,
		weight REAL DEFAULT 1.0,
		is_permanent INTEGER DEFAULT 0,
		last_accessed TEXT NOT NULL,
		FOREIGN KEY(from_node) REFERENCES graph_nodes(id) ON DELETE CASCADE,
		FOREIGN KEY(to_node) REFERENCES graph_nodes(id) ON DELETE CASCADE,
		UNIQUE(from_node, to_node, type)
	);
	CREATE INDEX IF NOT EXISTS idx_edges_from ON graph_edges(from_node);
	CREATE INDEX IF NOT EXISTS idx_edges_to ON graph_edges(to_node);
	`
	if _, err := db.Exec(ddl); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to initialize sqlite schema: %w", err)
	}

	return &SqliteStore{db: db}, nil
}

// Close 关闭 SQLite 连接，释放句柄资源
func (s *SqliteStore) Close() error {
	if s.db != nil {
		return s.db.Close()
	}
	return nil
}

// Append 物理持久化追加一个事件
func (s *SqliteStore) Append(ctx context.Context, ev event.Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	payloadBytes, err := json.Marshal(ev.Payload)
	if err != nil {
		return fmt.Errorf("failed to marshal payload: %w", err)
	}

	// 统一写入 RFC3339 纳秒级 UTC 字符串格式，保证跨平台、跨时区的一致性排序
	timeStr := ev.Timestamp.UTC().Format(time.RFC3339Nano)

	query := `INSERT INTO events (id, timestamp, actor, type, topic, payload) VALUES (?, ?, ?, ?, ?, ?)`
	_, err = s.db.ExecContext(ctx, query, ev.ID, timeStr, ev.Actor, string(ev.Type), ev.Topic, string(payloadBytes))
	if err != nil {
		return fmt.Errorf("failed to insert event into sqlite: %w", err)
	}

	return nil
}

// Query 实现复合过滤检索，并强制按时间戳升序排序防止时序颠倒
func (s *SqliteStore) Query(ctx context.Context, filter QueryFilter) ([]event.Event, error) {
	var sqlBuilder strings.Builder
	sqlBuilder.WriteString("SELECT id, timestamp, actor, type, topic, payload FROM events WHERE 1=1")
	var args []interface{}

	if filter.StartTime != nil {
		sqlBuilder.WriteString(" AND timestamp >= ?")
		args = append(args, filter.StartTime.UTC().Format(time.RFC3339Nano))
	}
	if filter.EndTime != nil {
		sqlBuilder.WriteString(" AND timestamp <= ?")
		args = append(args, filter.EndTime.UTC().Format(time.RFC3339Nano))
	}

	if len(filter.Actors) > 0 {
		sqlBuilder.WriteString(" AND actor IN (")
		for i, actor := range filter.Actors {
			if i > 0 {
				sqlBuilder.WriteString(", ")
			}
			sqlBuilder.WriteString("?")
			args = append(args, actor)
		}
		sqlBuilder.WriteString(")")
	}

	if len(filter.Types) > 0 {
		sqlBuilder.WriteString(" AND type IN (")
		for i, t := range filter.Types {
			if i > 0 {
				sqlBuilder.WriteString(", ")
			}
			sqlBuilder.WriteString("?")
			args = append(args, string(t))
		}
		sqlBuilder.WriteString(")")
	}

	if filter.Topic != "" && filter.Topic != "*" {
		if strings.HasSuffix(filter.Topic, "/*") {
			prefix := strings.TrimSuffix(filter.Topic, "/*")
			sqlBuilder.WriteString(" AND topic LIKE ?")
			args = append(args, prefix+"/%")
		} else {
			sqlBuilder.WriteString(" AND topic = ?")
			args = append(args, filter.Topic)
		}
	}

	// 1. 全文检索（FTS）功能预留与基础过滤实现
	if filter.SearchQuery != "" {
		// 【预留 FTS5 虚拟表】
		// 在当前基础版中，采用 Payload 的 LIKE 匹配实现免 CGO 开箱即用
		sqlBuilder.WriteString(" AND (payload LIKE ? OR topic LIKE ?)")
		args = append(args, "%"+filter.SearchQuery+"%", "%"+filter.SearchQuery+"%")
	}

	// 2. 向量检索功能预留接口桩
	if len(filter.Vector) > 0 {
		// 【预留向量相似度索引对接】
		// 纯 Go 环境无法直接加载外部 sqlite-vss/sqlite-vec 的 C 扩展。
		// 可以在此处记录警告并预留出从第三方向量数据库或内存 KNN 粗筛的桥接：
		fmt.Printf("💡 [Vector Search STUB] 接收到 %d 维 Embedding 向量。纯 Go 环境推荐使用外置内存向量计算，此处预留接口桩。\n", len(filter.Vector))
	}

	// 强制按时间戳升序排序，并在时间戳相同时按 rowid 物理插入顺序升序，从底层数据库层面杜绝因并发写入导致的时序颠倒
	sqlBuilder.WriteString(" ORDER BY timestamp ASC, rowid ASC")

	// 3. TopK 限制预留
	if filter.TopK > 0 {
		sqlBuilder.WriteString(" LIMIT ?")
		args = append(args, filter.TopK)
	}

	rows, err := s.db.QueryContext(ctx, sqlBuilder.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("failed to query events from sqlite: %w", err)
	}
	defer rows.Close()

	var events []event.Event
	for rows.Next() {
		var ev event.Event
		var timestampStr string
		var typeStr string
		var payloadStr string

		err := rows.Scan(&ev.ID, &timestampStr, &ev.Actor, &typeStr, &ev.Topic, &payloadStr)
		if err != nil {
			return nil, fmt.Errorf("failed to scan event row: %w", err)
		}

		// 健壮的时间戳还原逻辑，兼容多种可能的时间字符串格式
		t, err := time.Parse(time.RFC3339Nano, timestampStr)
		if err != nil {
			t, err = time.Parse(time.RFC3339, timestampStr)
			if err != nil {
				t, err = time.Parse("2006-01-02 15:04:05.999999999-07:00", timestampStr)
				if err != nil {
					t, err = time.Parse("2006-01-02 15:04:05", timestampStr)
					if err != nil {
						t = time.Now().UTC() // 极端兜底
					}
				}
			}
		}
		ev.Timestamp = t.UTC()
		ev.Type = event.EventType(typeStr)

		var payload map[string]interface{}
		if err := json.Unmarshal([]byte(payloadStr), &payload); err != nil {
			return nil, fmt.Errorf("failed to unmarshal payload of event %s: %w", ev.ID, err)
		}
		ev.Payload = payload

		events = append(events, ev)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error during row iteration: %w", err)
	}

	return events, nil
}

// Fold 复用 Query 结果对过滤出来的事件运行折叠计算，输出投影状态
func (s *SqliteStore) Fold(ctx context.Context, filter QueryFilter, initial interface{}, foldFn FoldFunc) (interface{}, error) {
	events, err := s.Query(ctx, filter)
	if err != nil {
		return nil, err
	}

	state := initial
	for _, ev := range events {
		state, err = foldFn(state, ev)
		if err != nil {
			return nil, err
		}
	}
	return state, nil
}
