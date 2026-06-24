use crate::llm::{Client, Message};
use std::sync::Arc;

pub struct Compressor {
    max_tool_output_len: usize,
    max_message_count: usize,
    client: Arc<dyn Client>,
}

impl Compressor {
    pub fn new(max_tool_output_len: usize, max_message_count: usize, client: Arc<dyn Client>) -> Self {
        Self {
            max_tool_output_len,
            max_message_count,
            client,
        }
    }

    pub fn compress_tool_output(&self, text: &str) -> String {
        if self.max_tool_output_len == 0 || text.len() <= self.max_tool_output_len {
            return text.to_string();
        }
        let half = self.max_tool_output_len / 2;
        let mut final_half = if half > text.len() / 2 { text.len() / 2 } else { half };
        
        // 寻找头部截断的安全 char 边界
        while final_half > 0 && !text.is_char_boundary(final_half) {
            final_half -= 1;
        }
        
        // 寻找尾部截断的安全 char 边界
        let mut tail_start = text.len() - final_half;
        while tail_start < text.len() && !text.is_char_boundary(tail_start) {
            tail_start += 1;
        }

        let truncated = text.len() - final_half - (text.len() - tail_start);
        format!(
            "{}\n\n... [已自动截断其核心 {} 字节以保全 Context，首尾展示如下] ...\n\n{}",
            &text[..final_half],
            truncated,
            &text[tail_start..]
        )
    }

    pub async fn compress_messages(&self, messages: Vec<Message>) -> Result<Vec<Message>, Box<dyn std::error::Error + Send + Sync>> {
        if self.max_message_count == 0 || messages.len() <= self.max_message_count {
            return Ok(messages);
        }

        let keep_recent = 4;
        if messages.len() < keep_recent + 2 {
            return Ok(messages);
        }

        let mut system_msg = None;
        let mut to_compress = Vec::new();
        let mut keep_msgs = Vec::new();

        let mut split_idx = messages.len() - keep_recent;
        if split_idx < 1 {
            split_idx = 1;
        }
        while split_idx > 1 {
            if messages[split_idx].role == "user" {
                break;
            }
            split_idx -= 1;
        }

        if split_idx <= 1 && messages[split_idx].role != "user" {
            return Ok(messages);
        }

        for (i, msg) in messages.into_iter().enumerate() {
            if i == 0 && msg.role == "system" {
                system_msg = Some(msg);
                continue;
            }
            if i >= split_idx {
                keep_msgs.push(msg);
            } else {
                to_compress.push(msg);
            }
        }

        if to_compress.is_empty() {
            let mut result = Vec::new();
            if let Some(sys) = system_msg {
                result.push(sys);
            }
            result.extend(keep_msgs);
            return Ok(result);
        }

        let summary = match self.summarize_messages(to_compress).await {
            Ok(sum) => sum,
            Err(_) => "[系统警告：由于上下文过长且自动摘要失败，在此处省略了较早的历史对话记录]".to_string(),
        };

        let mut result = Vec::with_capacity(keep_msgs.len() + 2);
        if let Some(sys) = system_msg {
            result.push(sys);
        }

        result.push(Message {
            role: "system".to_string(),
            content: format!("这是较早之前的对话历史摘要，供你参考：\n{}", summary),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        });
        result.extend(keep_msgs);

        Ok(result)
    }

    async fn summarize_messages(&self, msgs: Vec<Message>) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let mut prompt_msgs = vec![Message {
            role: "system".to_string(),
            content: "你是一个历史对话总结器。请你用极其精简、结构化的中文，总结给定的多轮历史对话。只需要输出总结内容，不要带任何前缀或解释。".to_string(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        }];

        let mut content_builder = String::new();
        for m in msgs {
            let name_str = match m.name {
                Some(ref n) => format!(" (工具: {})", n),
                None => "".to_string(),
            };
            content_builder.push_str(&format!("[{}]{}: {}\n", m.role, name_str, m.content));
        }

        prompt_msgs.push(Message {
            role: "user".to_string(),
            content: format!("请总结以下对话历史：\n{}", content_builder),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        });

        let resp = self.client.create_completion(prompt_msgs, Vec::new()).await?;
        Ok(resp.content)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::{Response, ToolDefinition};

    struct DummyClient;
    #[async_trait::async_trait]
    impl Client for DummyClient {
        async fn create_completion(
            &self,
            _messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
            Ok(Response {
                content: "summary result".to_string(),
                tool_calls: Vec::new(),
            })
        }
        async fn create_embedding(
            &self,
            _text: &str,
        ) -> Result<Vec<f32>, Box<dyn std::error::Error + Send + Sync>> {
            Ok(vec![0.0])
        }
    }

    #[tokio::test]
    async fn test_compress_tool_output() {
        let client = Arc::new(DummyClient);
        let comp = Compressor::new(10, 5, client);
        let out = comp.compress_tool_output("abcdefghijklmnop");
        assert!(out.contains("已自动截断"));
    }

    #[tokio::test]
    async fn test_compress_messages() {
        let client = Arc::new(DummyClient);
        let comp = Compressor::new(10, 5, client);

        let mut messages = vec![
            Message { role: "system".to_string(), content: "sys prompt".to_string(), name: None, tool_call_id: None, tool_calls: None },
        ];
        for i in 0..6 {
            let role = if i % 2 == 0 { "user" } else { "assistant" };
            messages.push(Message {
                role: role.to_string(),
                content: format!("msg {}", i),
                name: None,
                tool_call_id: None,
                tool_calls: None,
            });
        }

        let compressed = comp.compress_messages(messages).await.unwrap();
        // 应该成功触发压缩，并在 messages 中留下 system 消息、摘要消息以及最近的 4 条消息
        assert_eq!(compressed.len(), 6);
        assert_eq!(compressed[0].role, "system");
        assert!(compressed[1].content.contains("summary result"));
    }
}
