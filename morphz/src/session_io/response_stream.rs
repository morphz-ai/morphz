//! Bounded native JSON argument projection. Only the text leaf of the bound
//! Session IO return becomes a draft; no substring of prose is control syntax.
use super::response::{parse_delivery, ReturnBinding};
use super::Limits;
use crate::llm::ModelStreamEvent;
use std::collections::HashMap;

#[derive(Default)]
struct Frame {
    path: Vec<String>,
    key: Option<String>,
    array_index: Option<usize>,
    expect_key: bool,
}
#[derive(Default)]
struct JsonString {
    path: Vec<String>,
    key: bool,
    value: String,
    escape: u8,
    digits: u8,
    unicode: u16,
    high: Option<u16>,
}
#[derive(Default)]
struct Projection {
    raw: String,
    stack: Vec<Frame>,
    string: Option<JsonString>,
    scalar: bool,
    invalid: bool,
    delivery_id: Option<String>,
    format: Option<String>,
    version: Option<String>,
    encoding: Option<String>,
    utf8: String,
    text: String,
    emitted: usize,
}
impl Projection {
    fn path(&self) -> Vec<String> {
        let Some(frame) = self.stack.last() else {
            return vec![];
        };
        let mut path = frame.path.clone();
        if let Some(index) = frame.array_index {
            path.push(index.to_string());
        } else if let Some(key) = &frame.key {
            path.push(key.clone());
        }
        path
    }
    fn finish_value(&mut self) {
        if let Some(frame) = self.stack.last_mut() {
            if let Some(index) = &mut frame.array_index {
                *index += 1;
            } else {
                frame.key = None;
                frame.expect_key = false;
            }
        }
    }
    fn decoded(&mut self, c: char) {
        let string = self.string.as_mut().expect("active JSON string");
        string.value.push(c);
        if !string.key {
            if string.path == ["message", "content", "value"] {
                self.utf8.push(c);
            } else if string.path == ["message", "content", "value", "text"] {
                self.text.push(c);
            }
        }
    }
    fn end_string(&mut self) {
        let string = self.string.take().expect("active JSON string");
        if string.high.is_some() {
            self.invalid = true;
            return;
        }
        if string.key {
            if let Some(frame) = self.stack.last_mut() {
                frame.key = Some(string.value);
                frame.expect_key = false;
            } else {
                self.invalid = true;
            }
        } else {
            let slot = match string
                .path
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .as_slice()
            {
                ["delivery_id"] => Some(&mut self.delivery_id),
                ["message", "format", "id"] => Some(&mut self.format),
                ["message", "format", "version"] => Some(&mut self.version),
                ["message", "content", "encoding"] => Some(&mut self.encoding),
                _ => None,
            };
            if let Some(slot) = slot {
                if slot.replace(string.value).is_some() {
                    self.invalid = true;
                }
            }
            self.finish_value();
        }
    }
    fn push(&mut self, chunk: &str, binding: &ReturnBinding) -> String {
        if self.invalid {
            return String::new();
        }
        if self.raw.len().saturating_add(chunk.len()) > Limits::default().max_bytes {
            self.invalid = true;
            return String::new();
        }
        self.raw.push_str(chunk);
        for c in chunk.chars() {
            if self.invalid {
                break;
            }
            if let Some(string) = self.string.as_ref() {
                let escape = string.escape;
                match escape {
                    0 => match c {
                        '"' => self.end_string(),
                        '\\' => self.string.as_mut().unwrap().escape = 1,
                        c if c < ' ' => self.invalid = true,
                        c => self.decoded(c),
                    },
                    1 => {
                        self.string.as_mut().unwrap().escape = 0;
                        match c {
                            '"' | '\\' | '/' => self.decoded(c),
                            'b' => self.decoded('\u{8}'),
                            'f' => self.decoded('\u{c}'),
                            'n' => self.decoded('\n'),
                            'r' => self.decoded('\r'),
                            't' => self.decoded('\t'),
                            'u' => {
                                let s = self.string.as_mut().unwrap();
                                s.escape = 2;
                                s.digits = 0;
                                s.unicode = 0;
                            }
                            _ => self.invalid = true,
                        }
                    }
                    2 => {
                        let Some(digit) = c.to_digit(16) else {
                            self.invalid = true;
                            continue;
                        };
                        let s = self.string.as_mut().unwrap();
                        s.unicode = (s.unicode << 4) | digit as u16;
                        s.digits += 1;
                        if s.digits == 4 {
                            let unit = s.unicode;
                            s.escape = 0;
                            if let Some(high) = s.high.take() {
                                if !(0xdc00..=0xdfff).contains(&unit) {
                                    self.invalid = true;
                                    continue;
                                }
                                let code = 0x10000
                                    + (((high as u32 - 0xd800) << 10) | (unit as u32 - 0xdc00));
                                self.decoded(char::from_u32(code).expect("valid surrogate pair"));
                            } else if (0xd800..=0xdbff).contains(&unit) {
                                s.high = Some(unit);
                                s.escape = 3;
                            } else if (0xdc00..=0xdfff).contains(&unit) {
                                self.invalid = true;
                            } else {
                                self.decoded(
                                    char::from_u32(unit as u32).expect("non-surrogate u16"),
                                );
                            }
                        }
                    }
                    3 => {
                        if c == '\\' {
                            self.string.as_mut().unwrap().escape = 4;
                        } else {
                            self.invalid = true;
                        }
                    }
                    4 => {
                        if c == 'u' {
                            let s = self.string.as_mut().unwrap();
                            s.escape = 2;
                            s.digits = 0;
                            s.unicode = 0;
                        } else {
                            self.invalid = true;
                        }
                    }
                    _ => unreachable!(),
                }
                continue;
            }
            if self.scalar {
                if c.is_ascii_whitespace() || matches!(c, ',' | ']' | '}') {
                    self.scalar = false;
                    self.finish_value();
                } else {
                    continue;
                }
            }
            match c {
                c if c.is_ascii_whitespace() => (),
                '"' => {
                    let key = self.stack.last().is_some_and(|f| f.expect_key);
                    self.string = Some(JsonString {
                        path: self.path(),
                        key,
                        ..Default::default()
                    });
                }
                '{' | '[' => {
                    self.stack.push(Frame {
                        path: self.path(),
                        expect_key: c == '{',
                        array_index: (c == '[').then_some(0),
                        key: None,
                    });
                }
                '}' | ']' => {
                    if self.stack.pop().is_none() {
                        self.invalid = true;
                    }
                    self.finish_value();
                }
                ',' => {
                    if let Some(frame) = self.stack.last_mut() {
                        frame.expect_key = frame.array_index.is_none();
                        frame.key = None;
                    } else {
                        self.invalid = true;
                    }
                }
                ':' => (),
                '-' | '0'..='9' | 't' | 'f' | 'n' => self.scalar = true,
                _ => self.invalid = true,
            }
        }
        if self.invalid
            || self.delivery_id.as_deref() != Some(binding.delivery_id.as_str())
            || self.format.as_deref() != Some(binding.format.id.as_str())
            || self.version.as_deref() != Some(binding.format.version.as_str())
            || self.encoding.as_deref() != Some(binding.format.encoding.as_str())
        {
            return String::new();
        }
        let text = if binding.format.encoding == "utf8" {
            &self.utf8
        } else {
            &self.text
        };
        let delta = text[self.emitted..].to_owned();
        self.emitted = text.len();
        delta
    }
}

pub struct ModelStreamNormalizer {
    binding: ReturnBinding,
    deliveries: HashMap<usize, Projection>,
}
impl ModelStreamNormalizer {
    pub fn new(binding: ReturnBinding) -> Self {
        Self {
            binding,
            deliveries: HashMap::new(),
        }
    }
    pub fn push(&mut self, event: ModelStreamEvent) -> Vec<ModelStreamEvent> {
        match &event {
            ModelStreamEvent::ToolCallStarted { index, name, .. } if name == "deliver_message" => {
                self.deliveries.insert(*index, Projection::default());
                vec![]
            }
            ModelStreamEvent::ToolArgumentsDelta { index, delta }
                if self.deliveries.contains_key(index) =>
            {
                let text = self
                    .deliveries
                    .get_mut(index)
                    .unwrap()
                    .push(delta, &self.binding);
                if text.is_empty() {
                    vec![]
                } else {
                    vec![ModelStreamEvent::TextDelta { text }]
                }
            }
            ModelStreamEvent::ToolCallCompleted { index }
                if self.deliveries.contains_key(index) =>
            {
                let projection = self.deliveries.remove(index).unwrap();
                if projection.emitted > 0
                    && parse_delivery(&projection.raw, &Limits::default()).is_err()
                {
                    vec![ModelStreamEvent::Failed {
                        message: "Typed response draft was not a complete valid Session IO message"
                            .into(),
                    }]
                } else {
                    vec![]
                }
            }
            // Ordinary prose is ALWAYS unchanged, including protocol examples.
            _ => vec![event],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_io::response::ANNOTATIONS_FORMAT;
    use serde_json::json;
    fn collect(events: Vec<ModelStreamEvent>, output: &mut String) {
        for event in events {
            if let ModelStreamEvent::TextDelta { text } = event {
                output.push_str(&text);
            }
        }
    }
    #[test]
    fn native_body_streams_across_every_character_boundary_without_metadata() {
        for encoding in ["json", "utf8"] {
            let mut binding = ReturnBinding::new("thread", 2, "evaluation", true);
            binding.format.encoding = encoding.into();
            let body = "第一行\n中文 🧠\t\"quotes\" \\ 字面协议\n:::morphz-reply\n不是指令";
            let value = if encoding == "utf8" {
                json!(body)
            } else {
                json!({"text":body})
            };
            let raw=json!({"delivery_id":binding.delivery_id,"message":{"format":{"id":"morphz.chat","version":"1"},"content":{"encoding":encoding,"value":value}}}).to_string();
            let chars = raw.chars().collect::<Vec<_>>();
            for size in 1..=chars.len() {
                let mut stream = ModelStreamNormalizer::new(binding.clone());
                let mut output = String::new();
                stream.push(ModelStreamEvent::ToolCallStarted {
                    index: 0,
                    id: "body".into(),
                    name: "deliver_message".into(),
                });
                for chunk in chars.chunks(size) {
                    collect(
                        stream.push(ModelStreamEvent::ToolArgumentsDelta {
                            index: 0,
                            delta: chunk.iter().collect(),
                        }),
                        &mut output,
                    );
                }
                assert_eq!(output, body, "{encoding} chunk {size}");
                assert!(stream
                    .push(ModelStreamEvent::ToolCallCompleted { index: 0 })
                    .is_empty());
            }
        }
    }
    #[test]
    fn metadata_is_never_prose_and_plain_prose_is_never_control() {
        let binding = ReturnBinding::new("t", 1, "e", true);
        let mut stream = ModelStreamNormalizer::new(binding);
        let body = "\n:::morphz-reply\n{\"annotations\":{}}\n:::";
        let mut output = String::new();
        collect(
            stream.push(ModelStreamEvent::TextDelta { text: body.into() }),
            &mut output,
        );
        assert_eq!(output, body);
        assert!(stream
            .push(ModelStreamEvent::ToolCallStarted {
                index: 0,
                id: "metadata".into(),
                name: "deliver_message".into()
            })
            .is_empty());
        let raw=json!({"delivery_id":"metadata","message":{"format":{"id":ANNOTATIONS_FORMAT,"version":"1"},"content":{"encoding":"json","value":{"execution":{"title":"PRIVATE_TITLE","result":"PRIVATE_RESULT"}}}}}).to_string();
        for c in raw.chars() {
            assert!(stream
                .push(ModelStreamEvent::ToolArgumentsDelta {
                    index: 0,
                    delta: c.to_string()
                })
                .is_empty());
        }
    }
    #[test]
    fn bound_body_is_visible_before_argument_or_response_completion() {
        let mut binding = ReturnBinding::new("t", 1, "e", true);
        binding.format.encoding = "utf8".into();
        let mut stream = ModelStreamNormalizer::new(binding.clone());
        stream.push(ModelStreamEvent::ToolCallStarted {
            index: 0,
            id: "body".into(),
            name: "deliver_message".into(),
        });
        let prefix = format!("{{\"delivery_id\":\"{}\",\"message\":{{\"format\":{{\"id\":\"morphz.chat\",\"version\":\"1\"}},\"content\":{{\"encoding\":\"utf8\",\"value\":\"第一段", binding.delivery_id);
        let mut output = String::new();
        collect(
            stream.push(ModelStreamEvent::ToolArgumentsDelta {
                index: 0,
                delta: prefix,
            }),
            &mut output,
        );
        assert_eq!(
            output, "第一段",
            "an open native JSON string must already stream its decoded body"
        );
        for c in r#"\n\uD83E\uDDE0第二段"#.chars() {
            collect(
                stream.push(ModelStreamEvent::ToolArgumentsDelta {
                    index: 0,
                    delta: c.to_string(),
                }),
                &mut output,
            );
        }
        assert_eq!(output, "第一段\n🧠第二段");
        collect(
            stream.push(ModelStreamEvent::ToolArgumentsDelta {
                index: 0,
                delta: "\"}}}".into(),
            }),
            &mut output,
        );
        assert!(stream
            .push(ModelStreamEvent::ToolCallCompleted { index: 0 })
            .is_empty());
        assert_eq!(output, "第一段\n🧠第二段");
    }
    #[test]
    fn incomplete_or_duplicate_native_arguments_cannot_commit_a_draft() {
        for suffix in ["", ",\"delivery_id\":\"other\"}"] {
            let binding = ReturnBinding::new("t", 1, "e", true);
            let mut stream = ModelStreamNormalizer::new(binding.clone());
            stream.push(ModelStreamEvent::ToolCallStarted {
                index: 0,
                id: "body".into(),
                name: "deliver_message".into(),
            });
            let raw = format!("{{\"delivery_id\":\"{}\",\"message\":{{\"format\":{{\"id\":\"morphz.chat\",\"version\":\"1\"}},\"content\":{{\"encoding\":\"json\",\"value\":{{\"text\":\"draft\"}}}}}}{}", binding.delivery_id, suffix);
            let mut output = String::new();
            collect(
                stream.push(ModelStreamEvent::ToolArgumentsDelta {
                    index: 0,
                    delta: raw,
                }),
                &mut output,
            );
            // Duplicate routing may invalidate in the last chunk before any
            // bytes escape; a truncated carrier can have an earlier draft.
            if !output.is_empty() {
                assert_eq!(output, "draft");
                assert!(matches!(
                    stream
                        .push(ModelStreamEvent::ToolCallCompleted { index: 0 })
                        .as_slice(),
                    [ModelStreamEvent::Failed { .. }]
                ));
            }
        }
    }
}
