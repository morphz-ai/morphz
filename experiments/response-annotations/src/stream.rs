use crate::annotations::{parse_reply_arguments, Protocol, ProtocolError};
use morphz::llm::ModelStreamEvent;
use serde_json::Value;
use std::collections::HashMap;

fn error(message: &str) -> ProtocolError {
    ProtocolError(message.into())
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Key,
    Content,
    Ignored,
}
struct JsonString {
    role: Role,
    key: String,
    pending_high: Option<u16>,
}
impl JsonString {
    fn append(&mut self, character: char, output: &mut String) {
        match self.role {
            Role::Key => self.key.push(character),
            Role::Content => output.push(character),
            Role::Ignored => (),
        }
    }
    fn unit(&mut self, unit: u16, output: &mut String) -> Result<(), ProtocolError> {
        if let Some(high) = self.pending_high.take() {
            if !(0xdc00..=0xdfff).contains(&unit) {
                return Err(error("Invalid Unicode surrogate pair"));
            }
            let scalar = 0x10000 + (((high as u32) - 0xd800) << 10) + (unit as u32 - 0xdc00);
            self.append(char::from_u32(scalar).unwrap(), output);
        } else if (0xd800..=0xdbff).contains(&unit) {
            self.pending_high = Some(unit);
        } else if (0xdc00..=0xdfff).contains(&unit) {
            return Err(error("Unpaired low Unicode surrogate"));
        } else {
            self.append(char::from_u32(unit as u32).unwrap(), output);
        }
        Ok(())
    }
    fn character(&mut self, character: char, output: &mut String) -> Result<(), ProtocolError> {
        if self.pending_high.is_some() {
            return Err(error("Unpaired high Unicode surrogate"));
        }
        self.append(character, output);
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DecodedReply {
    pub content: String,
    pub annotations: Option<Value>,
    pub arguments: String,
}

/// Bounded incremental UTF-8 / JSON-string lexical decoder. Full JSON validation
/// is authoritative at finish. Only the root content string becomes public text.
pub struct ReplyContentDecoder {
    max_argument_bytes: usize,
    raw: Vec<u8>,
    pending_utf8: Vec<u8>,
    stack: Vec<char>,
    expect_root_key: bool,
    root_key: Option<String>,
    expect_root_value: bool,
    string: Option<JsonString>,
    escape: bool,
    unicode: Option<String>,
    content_seen: bool,
    content_finished: bool,
    finished: bool,
    emitted: String,
}
impl Default for ReplyContentDecoder {
    fn default() -> Self {
        Self::new(2_000_000)
    }
}
impl ReplyContentDecoder {
    pub fn new(max_argument_bytes: usize) -> Self {
        Self {
            max_argument_bytes,
            raw: vec![],
            pending_utf8: vec![],
            stack: vec![],
            expect_root_key: false,
            root_key: None,
            expect_root_value: false,
            string: None,
            escape: false,
            unicode: None,
            content_seen: false,
            content_finished: false,
            finished: false,
            emitted: String::new(),
        }
    }
    pub fn push(&mut self, delta: &str) -> Result<String, ProtocolError> {
        self.push_bytes(delta.as_bytes())
    }
    /// Transport-level fixture entry. Actual ModelStreamEvent deltas are already
    /// valid String, but this verifies arbitrary UTF-8 byte-boundary splitting.
    pub fn push_bytes(&mut self, delta: &[u8]) -> Result<String, ProtocolError> {
        if self.finished {
            return Err(error("Reply stream already finished"));
        }
        if delta.len() > self.max_argument_bytes.saturating_sub(self.raw.len()) {
            return Err(error("Reply argument budget exceeded"));
        }
        self.raw.extend_from_slice(delta);
        self.pending_utf8.extend_from_slice(delta);
        let valid_bytes = match std::str::from_utf8(&self.pending_utf8) {
            Ok(_) => self.pending_utf8.len(),
            Err(error) if error.error_len().is_none() => error.valid_up_to(),
            Err(_) => return Err(error("Invalid UTF-8 argument bytes")),
        };
        let valid = std::str::from_utf8(&self.pending_utf8[..valid_bytes])
            .unwrap()
            .to_string();
        self.pending_utf8.drain(..valid_bytes);
        let mut output = String::new();
        for character in valid.chars() {
            self.consume(character, &mut output)?;
        }
        self.emitted.push_str(&output);
        Ok(output)
    }
    fn consume(&mut self, character: char, output: &mut String) -> Result<(), ProtocolError> {
        if self.string.is_some() {
            if let Some(unicode) = &mut self.unicode {
                if !character.is_ascii_hexdigit() {
                    return Err(error("Invalid Unicode escape"));
                }
                unicode.push(character);
                if unicode.len() == 4 {
                    let unit = u16::from_str_radix(unicode, 16).unwrap();
                    self.unicode = None;
                    self.string.as_mut().unwrap().unit(unit, output)?;
                }
            } else if self.escape {
                self.escape = false;
                if character == 'u' {
                    self.unicode = Some(String::new());
                } else {
                    let character = match character {
                        '"' => '"',
                        '\\' => '\\',
                        '/' => '/',
                        'b' => '\u{8}',
                        'f' => '\u{c}',
                        'n' => '\n',
                        'r' => '\r',
                        't' => '\t',
                        _ => return Err(error("Invalid JSON string escape")),
                    };
                    self.string.as_mut().unwrap().character(character, output)?;
                }
            } else if character == '\\' {
                self.escape = true;
            } else if character == '"' {
                let string = self.string.take().unwrap();
                if string.pending_high.is_some() {
                    return Err(error("Unpaired high Unicode surrogate"));
                }
                if string.role == Role::Content {
                    self.content_finished = true;
                }
                if string.role == Role::Key {
                    self.root_key = Some(string.key);
                    self.expect_root_key = false;
                }
            } else {
                if character < '\u{20}' {
                    return Err(error("Unescaped JSON control character"));
                }
                self.string.as_mut().unwrap().character(character, output)?;
            }
            return Ok(());
        }
        if character.is_ascii_whitespace() {
            return Ok(());
        }
        match character {
            '"' => {
                let role = if self.stack.len() == 1 && self.stack[0] == '{' && self.expect_root_key
                {
                    Role::Key
                } else if self.stack.len() == 1
                    && self.expect_root_value
                    && self.root_key.as_deref() == Some("content")
                {
                    if self.content_seen {
                        return Err(error("Duplicate root content field"));
                    }
                    self.content_seen = true;
                    Role::Content
                } else {
                    Role::Ignored
                };
                self.string = Some(JsonString {
                    role,
                    key: String::new(),
                    pending_high: None,
                });
                self.expect_root_value = false;
            }
            '{' | '[' => {
                if self.stack.len() == 1
                    && self.expect_root_value
                    && self.root_key.as_deref() == Some("content")
                {
                    return Err(error("Reply content must be a string"));
                }
                if self.stack.len() >= 128 {
                    return Err(error("Reply JSON nesting budget exceeded"));
                }
                self.stack.push(character);
                if self.stack.len() == 1 {
                    self.expect_root_key = character == '{';
                }
                self.expect_root_value = false;
            }
            '}' | ']' => {
                self.stack.pop();
                self.expect_root_value = false;
            }
            ':' if self.stack.len() == 1 => self.expect_root_value = true,
            ',' if self.stack.len() == 1 => {
                self.expect_root_key = true;
                self.root_key = None;
                self.expect_root_value = false;
            }
            _ if self.stack.len() == 1
                && self.expect_root_value
                && self.root_key.as_deref() == Some("content") =>
            {
                return Err(error("Reply content must be a string"))
            }
            _ => (),
        }
        Ok(())
    }
    pub fn finish(&mut self) -> Result<DecodedReply, ProtocolError> {
        if self.finished {
            return Err(error("Reply stream already finished"));
        }
        self.finished = true;
        if !self.pending_utf8.is_empty() {
            return Err(error("Incomplete UTF-8 reply bytes"));
        }
        let arguments =
            String::from_utf8(self.raw.clone()).map_err(|_| error("Invalid UTF-8 reply bytes"))?;
        let args = parse_reply_arguments(&arguments)?;
        if !self.content_seen || !self.content_finished || self.emitted != args.content {
            return Err(error("Streamed content does not exactly match final reply"));
        }
        Ok(DecodedReply {
            content: args.content,
            annotations: args.annotations,
            arguments,
        })
    }
}

struct ToolStream {
    decoder: Option<ReplyContentDecoder>,
    reply: Option<DecodedReply>,
}
/// Full normalized ModelStreamEvent stream. Ordinary work events are preserved.
/// Raw reply events must be retained by the caller separately before push.
/// Construct one per response/model attempt, not one per entire execution.
pub struct ModelStreamNormalizer {
    enabled: bool,
    tools: HashMap<usize, ToolStream>,
    ordinary_text_seen: bool,
    reply_started: bool,
}
impl ModelStreamNormalizer {
    pub fn new(protocol: Protocol, typed_infer: bool) -> Self {
        Self {
            enabled: protocol == Protocol::V1 && !typed_infer,
            tools: HashMap::new(),
            ordinary_text_seen: false,
            reply_started: false,
        }
    }
    pub fn decoded_reply(&self) -> Option<&DecodedReply> {
        self.tools.values().find_map(|tool| tool.reply.as_ref())
    }
    pub fn push(
        &mut self,
        event: ModelStreamEvent,
    ) -> Result<Vec<ModelStreamEvent>, ProtocolError> {
        if !self.enabled {
            return Ok(vec![event]);
        }
        match &event {
            ModelStreamEvent::TextDelta { text } if !text.trim().is_empty() => {
                if self.reply_started {
                    return Err(error("reply cannot mix with ordinary content"));
                }
                self.ordinary_text_seen = true;
            }
            ModelStreamEvent::ToolCallStarted { index, name, .. } => {
                if self.tools.contains_key(index) {
                    return Err(error("Duplicate tool stream start"));
                }
                if self.reply_started
                    || name == "reply" && (!self.tools.is_empty() || self.ordinary_text_seen)
                {
                    return Err(error("reply must be sole call with no ordinary content"));
                }
                let decoder = if name == "reply" {
                    self.reply_started = true;
                    Some(ReplyContentDecoder::default())
                } else {
                    None
                };
                self.tools.insert(
                    *index,
                    ToolStream {
                        decoder,
                        reply: None,
                    },
                );
                if name == "reply" {
                    return Ok(vec![]);
                }
            }
            ModelStreamEvent::ToolArgumentsDelta { index, delta } => {
                let tool = self
                    .tools
                    .get_mut(index)
                    .ok_or_else(|| error("Arguments arrived before complete tool identity"))?;
                if let Some(decoder) = &mut tool.decoder {
                    let text = decoder.push(delta)?;
                    return Ok(if text.is_empty() {
                        vec![]
                    } else {
                        vec![ModelStreamEvent::TextDelta { text }]
                    });
                }
            }
            ModelStreamEvent::ToolCallCompleted { index } => {
                let tool = self
                    .tools
                    .get_mut(index)
                    .ok_or_else(|| error("Unknown completed tool"))?;
                if let Some(decoder) = &mut tool.decoder {
                    tool.reply = Some(decoder.finish()?);
                    return Ok(vec![]);
                }
            }
            ModelStreamEvent::Completed
                if self.reply_started
                    && self
                        .tools
                        .values()
                        .any(|tool| tool.decoder.is_some() && tool.reply.is_none()) =>
            {
                return Err(error("Completed reply lacks validated control body"))
            }
            _ => (),
        }
        Ok(vec![event])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn unicode_utf8_all_byte_splits_emit_before_finish_exact_body_no_metadata() {
        let content = "中文 🧠 \"引号\" \\ 换行\n制表\t尾";
        let raw=json!({"annotations":{"content":"nested hidden","execution":{"title":"不泄露"}},"content":content}).to_string();
        for split in 0..=raw.len() {
            let mut decoder = ReplyContentDecoder::default();
            let first = decoder.push_bytes(&raw.as_bytes()[..split]).unwrap();
            let second = decoder.push_bytes(&raw.as_bytes()[split..]).unwrap();
            assert_eq!(format!("{first}{second}"), content, "split {split}");
            assert_eq!(decoder.finish().unwrap().content, content);
        }
        let mut early = ReplyContentDecoder::default();
        assert_eq!(early.push("{\"content\":\"已经到达").unwrap(), "已经到达");
        early
            .push("\",\"annotations\":{\"execution\":{\"result\":\"后到\"}}}")
            .unwrap();
        early.finish().unwrap();
    }
    #[test]
    fn escaped_keys_unicode_surrogate_pairs_all_splits() {
        let raw = r#"{"ann\u006ftations":{"content":"hidden"},"c\u006fntent":"\u4e2d\u6587 \ud83e\udde0 \" \\ \n"}"#;
        let expected: Value = serde_json::from_str(raw).unwrap();
        let expected = expected["content"].as_str().unwrap();
        for width in 1..14 {
            let mut decoder = ReplyContentDecoder::default();
            let mut text = String::new();
            for delta in raw.as_bytes().chunks(width) {
                text.push_str(&decoder.push_bytes(delta).unwrap());
            }
            assert_eq!(text, expected);
            assert_eq!(decoder.finish().unwrap().content, expected);
        }
    }
    #[test]
    fn malformed_incomplete_duplicate_utf8_and_unpaired_surrogates_rejected() {
        for raw in [
            r#"{"content":12}"#,
            r#"{"content":"a","content":"b"}"#,
            r#"{"content":"\q"}"#,
            r#"{"content":"\u12g4"}"#,
            r#"{"content":"\ud800x"}"#,
            r#"{"content":"\udc00"}"#,
        ] {
            let mut decoder = ReplyContentDecoder::default();
            assert!(decoder.push(raw).is_err(), "{raw}");
        }
        let mut incomplete = ReplyContentDecoder::default();
        incomplete.push("{\"content\":\"partial").unwrap();
        assert!(incomplete.finish().is_err());
        let mut invalid = ReplyContentDecoder::default();
        assert!(invalid.push_bytes(&[0xff]).is_err());
        let mut split_utf8 = ReplyContentDecoder::default();
        split_utf8.push_bytes(&[0xe4]).unwrap();
        assert!(split_utf8.finish().is_err());
        let mut control = ReplyContentDecoder::default();
        control
            .push(r#"{"content":"正文","status":"success"}"#)
            .unwrap();
        assert!(control.finish().is_err());
        assert!(ReplyContentDecoder::new(10).push("xxxxxxxxxxx").is_err());
    }
    #[test]
    fn long_body_linear_incremental_matching() {
        let content = "长文本🧠\\\"\n".repeat(50_000);
        let raw =
            json!({"content":content,"annotations":{"execution":{"result":"末尾"}}}).to_string();
        let mut decoder = ReplyContentDecoder::default();
        let mut text = String::new();
        for delta in raw.as_bytes().chunks(97) {
            text.push_str(&decoder.push_bytes(delta).unwrap());
        }
        assert_eq!(text, content);
        assert_eq!(decoder.finish().unwrap().content, content);
    }
    #[test]
    fn full_model_stream_preserves_real_tool_events_and_off_bytes_exactly() {
        let events = vec![
            ModelStreamEvent::Started,
            ModelStreamEvent::ToolCallStarted {
                index: 0,
                id: "work".into(),
                name: "exec".into(),
            },
            ModelStreamEvent::ToolArgumentsDelta {
                index: 0,
                delta: r#"{"command":"secret"}"#.into(),
            },
            ModelStreamEvent::ToolCallCompleted { index: 0 },
            ModelStreamEvent::Completed,
        ];
        for protocol in [Protocol::Off, Protocol::V1] {
            let mut stream = ModelStreamNormalizer::new(protocol, false);
            let mut normalized = vec![];
            for event in events.clone() {
                normalized.extend(stream.push(event).unwrap());
            }
            assert_eq!(
                serde_json::to_vec(&events).unwrap(),
                serde_json::to_vec(&normalized).unwrap()
            );
        }
        let mut off = ModelStreamNormalizer::new(Protocol::Off, false);
        let unknown = ModelStreamEvent::ToolArgumentsDelta {
            index: 9,
            delta: "raw business".into(),
        };
        assert_eq!(off.push(unknown.clone()).unwrap(), vec![unknown]);
    }
    #[test]
    fn reply_normalizes_real_event_type_without_work_turn_and_mixed_control_rejected() {
        let mut stream = ModelStreamNormalizer::new(Protocol::V1, false);
        assert!(stream
            .push(ModelStreamEvent::ToolCallStarted {
                index: 0,
                id: "r".into(),
                name: "reply".into()
            })
            .unwrap()
            .is_empty());
        assert_eq!(
            stream
                .push(ModelStreamEvent::ToolArgumentsDelta {
                    index: 0,
                    delta: "{\"content\":\"中文".into()
                })
                .unwrap(),
            vec![ModelStreamEvent::TextDelta {
                text: "中文".into()
            }]
        );
        assert!(stream
            .push(ModelStreamEvent::ToolArgumentsDelta {
                index: 0,
                delta: "\",\"annotations\":{\"execution\":{\"result\":\"隐藏\"}}}".into()
            })
            .unwrap()
            .is_empty());
        assert!(stream
            .push(ModelStreamEvent::ToolCallCompleted { index: 0 })
            .unwrap()
            .is_empty());
        assert_eq!(
            stream.push(ModelStreamEvent::Completed).unwrap(),
            vec![ModelStreamEvent::Completed]
        );
        assert_eq!(stream.decoded_reply().unwrap().content, "中文");
        assert!(stream
            .push(ModelStreamEvent::ToolCallStarted {
                index: 1,
                id: "w".into(),
                name: "exec".into()
            })
            .is_err());
        let mut missing = ModelStreamNormalizer::new(Protocol::V1, false);
        assert!(missing
            .push(ModelStreamEvent::ToolArgumentsDelta {
                index: 0,
                delta: "{}".into()
            })
            .is_err());
        let mut unfinished = ModelStreamNormalizer::new(Protocol::V1, false);
        unfinished
            .push(ModelStreamEvent::ToolCallStarted {
                index: 0,
                id: "r".into(),
                name: "reply".into(),
            })
            .unwrap();
        assert!(unfinished.push(ModelStreamEvent::Completed).is_err());
    }
}
