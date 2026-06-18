package event

import (
	"encoding/json"
	"time"
)

// EventType 表示事件的语义类型
type EventType string

const (
	TypeUserMessage EventType = "user_message"
	TypeAgentCall   EventType = "agent_call"
	TypeToolOutput  EventType = "tool_output"
	TypeFileChange  EventType = "file_change"
	TypeException   EventType = "exception"
	TypeProposal    EventType = "proposal"
)

// Event 对应情境记忆中的不可变事件
type Event struct {
	ID        string                 `json:"id"`
	Timestamp time.Time              `json:"timestamp"`
	Actor     string                 `json:"actor"`
	Type      EventType              `json:"type"`
	Topic     string                 `json:"topic"`
	Payload   map[string]interface{} `json:"payload"`
}

// NewEvent 创建一个新事件实体
func NewEvent(id string, actor string, evType EventType, topic string, payload map[string]interface{}) Event {
	return Event{
		ID:        id,
		Timestamp: time.Now().UTC(),
		Actor:     actor,
		Type:      evType,
		Topic:     topic,
		Payload:   payload,
	}
}

// Marshal 序列化事件
func (e Event) Marshal() ([]byte, error) {
	return json.Marshal(e)
}
