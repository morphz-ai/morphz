//! Bounded native JSON argument projection. Only the text leaf of the bound
//! Session IO return becomes a draft; no substring of prose is control syntax.
use super::response::{parse_delivery, ReturnBinding};
use super::Limits;
use crate::llm::ModelStreamEvent;
use std::collections::{HashMap, HashSet};

#[derive(Default)]
struct Frame {
    path: Vec<String>,
    key: Option<String>,
    array_index: Option<usize>,
    expect_key: bool,
    expect_colon: bool,
    keys: HashSet<String>,
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
    evaluation: bool,
    target_path: Option<Vec<String>>,
    // Preserve the original JSON business value for internal typed streams;
    // public visibility remains owned by the Runtime route/parent proof.
    raw_value_path: Option<Vec<String>>,
    booleans: HashMap<Vec<String>, bool>,
    has_effects: bool,
    scalar_path: Vec<String>,
    scalar_text: String,
    raw: String,
    at_byte: usize,
    value_start: Option<usize>,
    value_end: Option<usize>,
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
    fn is_raw_value_path(&self, path: &[String]) -> bool {
        self.raw_value_path.as_ref().map_or_else(
            || path == ["message", "content", "value"],
            |target| path == target,
        )
    }
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
        if self.is_raw_value_path(&self.path())
            && self.value_start.is_some()
            && self.value_end.is_none()
        {
            self.value_end = Some(self.at_byte + 1);
        }
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
            if let Some(path) = &self.target_path {
                if &string.path == path {
                    self.text.push(c);
                }
            } else if string.path == ["message", "content", "value"] {
                self.utf8.push(c);
            } else if string.path == ["message", "content", "value", "text"]
                || (self.evaluation && string.path == ["body"])
            {
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
                if !frame.keys.insert(string.value.clone()) {
                    self.invalid = true;
                    return;
                }
                frame.key = Some(string.value);
                frame.expect_key = false;
                frame.expect_colon = true;
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
        let base = self.raw.len();
        self.raw.push_str(chunk);
        for (offset, c) in chunk.char_indices() {
            self.at_byte = base + offset;
            if self.invalid {
                break;
            }
            if self.value_start.is_none()
                && self.string.is_none()
                && !self.scalar
                && self.is_raw_value_path(&self.path())
                && !self.stack.last().is_some_and(|frame| frame.expect_colon)
                && matches!(c, '"' | '{' | '[' | 't' | 'f' | 'n' | '-' | '0'..='9')
            {
                self.value_start = Some(self.at_byte);
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
                    if self.is_raw_value_path(&self.scalar_path) {
                        self.value_end = Some(self.at_byte);
                    }
                    if let Some(value) = match self.scalar_text.as_str() {
                        "true" => Some(true),
                        "false" => Some(false),
                        _ => None,
                    } {
                        self.booleans.insert(self.scalar_path.clone(), value);
                    }
                    self.scalar = false;
                    self.finish_value();
                } else {
                    self.scalar_text.push(c);
                    continue;
                }
            }
            if self.stack.last().is_some_and(|frame| frame.expect_colon)
                && c != ':'
                && !c.is_ascii_whitespace()
            {
                self.invalid = true;
                continue;
            }
            if !c.is_ascii_whitespace()
                && c != ']'
                && self
                    .stack
                    .last()
                    .is_some_and(|frame| frame.path == ["effects"] && frame.array_index.is_some())
            {
                self.has_effects = true;
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
                        expect_colon: false,
                        keys: HashSet::new(),
                    });
                }
                '}' | ']' => {
                    match self.stack.pop() {
                        Some(frame) if (c == ']') == frame.array_index.is_some() => {}
                        _ => self.invalid = true,
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
                ':' => {
                    if let Some(frame) = self.stack.last_mut().filter(|frame| frame.expect_colon) {
                        frame.expect_colon = false;
                    } else {
                        self.invalid = true;
                    }
                }
                '-' | '0'..='9' | 't' | 'f' | 'n' => {
                    self.scalar = true;
                    self.scalar_path = self.path();
                    self.scalar_text = c.to_string();
                }
                _ => self.invalid = true,
            }
        }
        if self.invalid
            || (!self.evaluation
                && (self.delivery_id.as_deref() != Some(binding.delivery_id.as_str())
                    || self.format.as_deref() != Some(binding.format.id.as_str())
                    || self.version.as_deref() != Some(binding.format.version.as_str())
                    || self.encoding.as_deref() != Some(binding.format.encoding.as_str())))
        {
            return String::new();
        }
        let text = if self.raw_value_path.is_some() || (!self.evaluation
            && binding.format.id != "morphz.chat"
            && binding.format.encoding == "json")
        {
            self.value_start
                .map(|start| &self.raw[start..self.value_end.unwrap_or(self.raw.len())])
                .unwrap_or("")
        } else if !self.evaluation && binding.format.encoding == "utf8" {
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
    evaluation: Projection,
    unified: Option<UnifiedStream>,
}

#[derive(Default)]
struct UnifiedStream {
    raw: String,
    parser: Projection,
    // No scanning delimiters or inner prose: the frozen binding owns one full
    // value. Plain implicit replies are streamed as-is on weaker transports.
    mode: Option<bool>, // true = structured JSON, false = implicit text
    emitted: String,
    calls: std::collections::BTreeMap<usize, crate::llm::ToolCallRepr>,
    failed: bool,
}
impl UnifiedStream {
    fn failure(&mut self, message: impl Into<String>) -> Vec<ModelStreamEvent> {
        self.failed = true;
        vec![ModelStreamEvent::Failed { message: message.into() }]
    }

    fn push(&mut self, event: ModelStreamEvent, binding: &ReturnBinding) -> Vec<ModelStreamEvent> {
        if self.failed {
            return vec![];
        }
        match &event {
            ModelStreamEvent::TextDelta { text } => {
                if self.raw.len().saturating_add(text.len()) > Limits::default().max_bytes {
                    return self.failure("Session IO output exceeded its frozen byte budget");
                }
                self.raw.push_str(text);
                let first_chunk = self.mode.is_none();
                if first_chunk {
                    let Some(first) = self.raw.trim_start().chars().next() else {
                        return vec![];
                    };
                    self.mode = Some(matches!(first, '{' | '[' | '"'));
                    self.parser.evaluation = true;
                    if first == '"' {
                        self.parser.target_path = Some(vec![]);
                    }
                    if binding.format.id != "morphz.chat" && binding.format.encoding == "json" {
                        self.parser.raw_value_path = Some(if first == '{' {
                            vec!["body".into()]
                        } else {
                            vec![]
                        });
                    }
                }
                let chunk = if first_chunk { &self.raw } else { text };
                let delta = if self.mode == Some(true) {
                    self.parser.push(chunk, binding)
                } else {
                    chunk.to_owned()
                };
                if delta.is_empty() { return vec![]; }
                self.emitted.push_str(&delta);
                vec![ModelStreamEvent::TextDelta { text: delta }]
            }
            ModelStreamEvent::ToolCallStarted { index, id, name } => {
                self.calls.insert(*index, crate::llm::ToolCallRepr {
                    id: id.clone(), r#type: "function".into(), func_name: name.clone(), arguments: String::new(),
                });
                vec![event]
            }
            ModelStreamEvent::ToolArgumentsDelta { index, delta } => {
                let Some(call) = self.calls.get_mut(index) else {
                    return self.failure("Native arguments arrived without their actual call identity");
                };
                if call.arguments.len().saturating_add(delta.len()) > Limits::default().max_bytes {
                    return self.failure("Native arguments exceeded the Session IO byte budget");
                }
                call.arguments.push_str(delta);
                vec![event]
            }
            ModelStreamEvent::Completed => {
                let raw = crate::llm::Response {
                    content: self.raw.clone(), tool_calls: self.calls.values().cloned().collect(),
                };
                let parts = match super::unified::decode(&raw, binding, "stream-validation") {
                    Ok(parts) => parts,
                    Err(error) => return self.failure(error.to_string()),
                };
                // Internal typed streams preserve JSON spelling (including
                // String quotes), not the Evaluation wrapper or annotations.
                // A separately proven parent projection alone is public.
                if binding.format.id != "morphz.chat" && binding.format.encoding == "json" {
                    let mut events = vec![];
                    if parts.response.tool_calls.is_empty() {
                        if self.emitted.is_empty() {
                            events.push(ModelStreamEvent::TextDelta { text: parts.response.content });
                        } else if super::Data::parse(self.emitted.as_bytes(), &Limits::default()).ok()
                            != super::Data::parse(parts.response.content.as_bytes(), &Limits::default()).ok()
                        {
                            return self.failure("The provisional typed body differs from its complete value");
                        }
                    }
                    self.failed = true;
                    events.push(event);
                    return events;
                }
                if !parts.response.content.starts_with(&self.emitted) {
                    return self.failure("The provisional body differs from the complete bound return");
                }
                let remaining = parts.response.content[self.emitted.len()..].to_string();
                self.emitted.push_str(&remaining);
                let mut events = vec![];
                if !remaining.is_empty() { events.push(ModelStreamEvent::TextDelta { text: remaining }); }
                events.push(event);
                self.failed = true;
                events
            }
            ModelStreamEvent::Failed { message } => self.failure(message.clone()),
            _ => vec![event],
        }
    }
}

/// Reads only a Runtime-proven identity projection of a typed business value.
/// It never recognizes control syntax in prose and never decides parent work.
/// A parent condition must already be present as its actual Bool value before
/// any leaf becomes a provisional public draft. Field order is irrelevant.
pub struct ReplyProjector {
    candidates: Vec<(crate::sexpr_eval::ReplyProjection, Projection)>,
    binding: ReturnBinding,
    chosen: Option<usize>,
    emitted: usize,
    evaluation: bool,
}
impl ReplyProjector {
    pub fn new(projections: Vec<crate::sexpr_eval::ReplyProjection>, evaluation: bool) -> Self {
        Self {
            candidates: projections
                .into_iter()
                .take(8)
                .map(|proof| {
                    let mut path = proof.path.clone();
                    if evaluation {
                        path.insert(0, "body".into());
                    }
                    let parser = Projection {
                        evaluation: true,
                        target_path: Some(path),
                        ..Default::default()
                    };
                    (proof, parser)
                })
                .collect(),
            binding: ReturnBinding::new("", 0, "", false),
            chosen: None,
            emitted: 0,
            evaluation,
        }
    }
    pub fn push(&mut self, chunk: &str) -> super::IoResult<String> {
        for (_, parser) in &mut self.candidates {
            let _ = parser.push(chunk, &self.binding);
        }
        if self.evaluation && self.candidates.iter().any(|(_, parser)| parser.has_effects) {
            if self.emitted > 0 {
                return Err(super::IoError::new(
                    "invalid_delivery_contract",
                    "A provisional typed return was followed by work; it was not admitted",
                ));
            }
            return Ok(String::new());
        }
        if self.chosen.is_none() {
            let matched = self
                .candidates
                .iter()
                .enumerate()
                .filter(|(_, (proof, parser))| {
                    !parser.invalid
                        && proof.conditions.iter().all(|guard| {
                            let mut path = guard.path.clone();
                            if self.evaluation {
                                path.insert(0, "body".into());
                            }
                            parser.booleans.get(&path) == Some(&guard.value)
                        })
                })
                .map(|(index, _)| index)
                .collect::<Vec<_>>();
            if matched.len() == 1 {
                self.chosen = matched.first().copied();
            }
        }
        let Some(index) = self.chosen else {
            return Ok(String::new());
        };
        let (_, parser) = &self.candidates[index];
        if parser.invalid {
            return Err(super::IoError::new(
                "invalid_content_syntax",
                "The projected business value is invalid; no final value was admitted",
            ));
        }
        let delta = parser.text[self.emitted..].to_string();
        self.emitted = parser.text.len();
        Ok(delta)
    }
    pub fn proof(&self) -> Option<&crate::sexpr_eval::ReplyProjection> {
        self.chosen.map(|index| &self.candidates[index].0)
    }
}
impl ModelStreamNormalizer {
    pub fn new(binding: ReturnBinding) -> Self {
        let unified = super::unified::selected(&binding).then(UnifiedStream::default);
        Self {
            binding,
            unified,
            deliveries: HashMap::new(),
            evaluation: Projection {
                evaluation: true,
                ..Default::default()
            },
        }
    }
    pub fn push(&mut self, event: ModelStreamEvent) -> Vec<ModelStreamEvent> {
        if let Some(unified) = &mut self.unified {
            return unified.push(event, &self.binding);
        }
        match &event {
            ModelStreamEvent::TextDelta { text } if self.binding.output.is_some() => {
                let text = self.evaluation.push(text, &self.binding);
                if text.is_empty() {
                    vec![]
                } else {
                    vec![ModelStreamEvent::TextDelta { text }]
                }
            }
            ModelStreamEvent::Completed if self.binding.output.is_some() => {
                let valid = self.binding.output.as_ref().is_some_and(|format| {
                    super::evaluation::message(&self.evaluation.raw, format, &Limits::default())
                        .is_ok()
                });
                if valid {
                    vec![event]
                } else {
                    vec![ModelStreamEvent::Failed {
                        message:
                            "The native Session IO output did not complete its admitted structure"
                                .into(),
                    }]
                }
            }
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

    #[test]
    fn parent_reply_preview_requires_actual_guards_and_projects_only_the_proven_leaf() {
        use crate::sexpr_eval::{ReplyProjection, ReplyProjectionCondition};
        let proof = ReplyProjection {
            path: vec!["answer".into()],
            conditions: vec![ReplyProjectionCondition {
                path: vec!["execute".into()],
                value: false,
            }],
        };
        let body = "中文 \"引号\" 🧠\n第二行";
        for raw in [
            serde_json::json!({"execute":false,"answer":body,"private":"secret"}).to_string(),
            format!(
                "{{\"answer\":{},\"private\":\"secret\",\"execute\":false}}",
                serde_json::json!(body)
            ),
        ] {
            for size in 1..=raw.chars().count() {
                let mut projector = ReplyProjector::new(vec![proof.clone()], false);
                let mut shown = String::new();
                for chunk in raw.chars().collect::<Vec<_>>().chunks(size) {
                    shown.push_str(&projector.push(&chunk.iter().collect::<String>()).unwrap());
                }
                assert_eq!(shown, body);
                assert_eq!(projector.proof(), Some(&proof));
            }
        }
        let mut pending = ReplyProjector::new(vec![proof.clone()], false);
        assert_eq!(pending.push("{\"answer\":\"must not show\",").unwrap(), "");
        assert_eq!(pending.push("\"execute\":true}").unwrap(), "");
        let mut missing = ReplyProjector::new(vec![proof.clone()], false);
        assert_eq!(missing.push("{\"answer\":\"must not show\"}").unwrap(), "");
        let mut string = ReplyProjector::new(
            vec![ReplyProjection {
                path: vec![],
                conditions: vec![],
            }],
            false,
        );
        let raw = serde_json::json!(body).to_string();
        let mut shown = String::new();
        for character in raw.chars() {
            shown.push_str(&string.push(&character.to_string()).unwrap());
        }
        assert_eq!(shown, body);
        for raw in [
            r#"{"effects":[],"body":{"execute":false,"answer":"answer"},"annotations":{}}"#,
            r#"{"body":{"answer":"answer","execute":false},"effects":[],"annotations":{}}"#,
        ] {
            let mut native = ReplyProjector::new(vec![proof.clone()], true);
            let mut shown = String::new();
            for c in raw.chars() {
                shown.push_str(&native.push(&c.to_string()).unwrap());
            }
            assert_eq!(shown, "answer");
            assert_eq!(native.proof(), Some(&proof));
        }
        let mut work = ReplyProjector::new(vec![proof], true);
        assert_eq!(work.push(r#"{"body":{"execute":false,"answer":"private progress"},"effects":[{"name":"read"}]}"#).unwrap(), "");
    }
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
            let mut binding = ReturnBinding::new("thread", 2, "evaluation", false);
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
        let binding = ReturnBinding::new("t", 1, "e", false);
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
        let mut binding = ReturnBinding::new("t", 1, "e", false);
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
            let binding = ReturnBinding::new("t", 1, "e", false);
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

    #[test]
    fn evaluation_stream_projects_only_the_body_for_all_field_orders_and_chunk_sizes() {
        let body = "第一行\n\"引号\" 🧠 \\ 路径\n:::morphz-reply\n普通协议示例";
        let annotations = json!({"execution":{"title":"PRIVATE_TITLE","progress":"","result":"PRIVATE_RESULT"},"observations":[]});
        let bodies = [
            format!(
                "{{\"body\":{},\"annotations\":{annotations},\"effects\":[]}}",
                json!(body)
            ),
            format!(
                "{{\"annotations\":{annotations},\"effects\":[],\"body\":{}}}",
                json!(body)
            ),
        ];
        for raw in bodies {
            let chars = raw.chars().collect::<Vec<_>>();
            for size in 1..=chars.len() {
                let mut stream = ModelStreamNormalizer::new(legacy_binding());
                let mut output = String::new();
                for chunk in chars.chunks(size) {
                    collect(
                        stream.push(ModelStreamEvent::TextDelta {
                            text: chunk.iter().collect(),
                        }),
                        &mut output,
                    );
                }
                assert_eq!(output, body, "chunk {size}");
                assert_eq!(
                    stream.push(ModelStreamEvent::Completed),
                    vec![ModelStreamEvent::Completed]
                );
            }
        }
    }

    #[test]
    fn evaluation_body_is_visible_before_the_json_string_or_response_ends() {
        let mut stream = ModelStreamNormalizer::new(legacy_binding());
        let mut output = String::new();
        collect(
            stream.push(ModelStreamEvent::TextDelta {
                text: r#"{"body":"第一段\n\uD83E\uDDE0"#.into(),
            }),
            &mut output,
        );
        assert_eq!(output, "第一段\n🧠");
        assert!(matches!(
            stream.push(ModelStreamEvent::Completed).as_slice(),
            [ModelStreamEvent::Failed { .. }]
        ));
    }

    #[test]
    fn malformed_colons_duplicate_bodies_and_trailing_data_never_complete_or_leak_metadata() {
        for raw in [
            r#"{"body" "PRIVATE_METADATA"}"#,
            r#"{"body":"visible","body":"PRIVATE_DUPLICATE"}"#,
            r#"{"body":"visible","annotations":{},"effects":[]}}"#,
        ] {
            let mut stream = ModelStreamNormalizer::new(legacy_binding());
            let mut output = String::new();
            for c in raw.chars() {
                collect(
                    stream.push(ModelStreamEvent::TextDelta {
                        text: c.to_string(),
                    }),
                    &mut output,
                );
            }
            assert!(!output.contains("PRIVATE"));
            assert!(matches!(
                stream.push(ModelStreamEvent::Completed).as_slice(),
                [ModelStreamEvent::Failed { .. }]
            ));
        }
    }

    fn legacy_binding() -> ReturnBinding {
        let mut binding = ReturnBinding::new("t", 1, "e", true);
        binding.output = Some(crate::session_io::evaluation::binding());
        binding
    }

    #[test]
    fn unified_body_streams_incrementally_without_leaking_any_display_metadata() {
        let body = "第一行\n\"引号\" 🧠 \\ <context_annotation>这是正文</context_annotation>\n{\"effects\":[]}";
        for enabled in [false, true] {
            for metadata in [json!(null), json!({"execution":{"title":"PRIVATE_TITLE"},"observations_note":null}), json!(false)] {
                for raw in [
                    format!("{{\"body\":{},\"annotations\":{metadata},\"effects\":[]}}", json!(body)),
                    format!("{{\"annotations\":{metadata},\"effects\":[],\"body\":{}}}", json!(body)),
                ] {
                    let chars = raw.chars().collect::<Vec<_>>();
                    for size in [1, 2, 5, 17, chars.len()] {
                        let mut stream = ModelStreamNormalizer::new(ReturnBinding::new("t", 1, "e", enabled).with_unified_output());
                        let mut output = String::new();
                        for chunk in chars.chunks(size) {
                            collect(stream.push(ModelStreamEvent::TextDelta { text: chunk.iter().collect() }), &mut output);
                        }
                        assert_eq!(output, body, "body is visible before completion, chunk size={size}");
                        assert_eq!(stream.push(ModelStreamEvent::Completed), vec![ModelStreamEvent::Completed]);
                        assert!(stream.push(ModelStreamEvent::TextDelta { text: "AFTER_TERMINAL".into() }).is_empty());
                    }
                }
            }
        }
    }

    #[test]
    fn unified_open_strings_and_unicode_escapes_stream_before_the_return_finishes() {
        let mut stream = ModelStreamNormalizer::new(ReturnBinding::new("t", 1, "e", true).with_unified_output());
        let mut output = String::new();
        for c in r#"{"body":"第一段\n\uD83E\uDDE0"#.chars() {
            collect(stream.push(ModelStreamEvent::TextDelta { text: c.to_string() }), &mut output);
        }
        assert_eq!(output, "第一段\n🧠");
        assert!(matches!(stream.push(ModelStreamEvent::Completed).as_slice(), [ModelStreamEvent::Failed { .. }]));
    }

    #[test]
    fn unified_plain_fallback_is_not_scanned_for_inner_protocol_examples() {
        let body = "正常回复\n{\"body\":\"不是外壳\",\"effects\":[{}]}\n<context_annotation>原样保留</context_annotation>";
        for raw in [body.to_string(), json!(body).to_string()] {
            let mut stream = ModelStreamNormalizer::new(ReturnBinding::new("t", 1, "e", true).with_unified_output());
            let mut output = String::new();
            for c in raw.chars() {
                collect(stream.push(ModelStreamEvent::TextDelta { text: c.to_string() }), &mut output);
            }
            collect(stream.push(ModelStreamEvent::Completed), &mut output);
            assert_eq!(output, body);
        }
    }

    #[test]
    fn unified_invalid_business_returns_do_not_finish_or_leak_metadata() {
        for raw in [
            r#"{"annotations":{"execution":{"title":"PRIVATE"}}}"#,
            r#"{"body":null,"effects":[]}"#,
            r#"{"body":"draft","body":"PRIVATE_DUPLICATE"}"#,
            r#"{"body":"draft","effects":[]}}"#,
            r#"{"body":"draft","effects":"PRIVATE_INVALID"}"#,
            r#"{"body" "PRIVATE_INVALID"}"#,
        ] {
            let mut stream = ModelStreamNormalizer::new(ReturnBinding::new("t", 1, "e", true).with_unified_output());
            let mut output = String::new();
            for c in raw.chars() {
                collect(stream.push(ModelStreamEvent::TextDelta { text: c.to_string() }), &mut output);
            }
            assert!(!output.contains("PRIVATE"));
            assert!(matches!(stream.push(ModelStreamEvent::Completed).as_slice(), [ModelStreamEvent::Failed { .. }]));
            assert!(stream.push(ModelStreamEvent::Completed).is_empty());
        }
    }

    #[test]
    fn unified_native_work_fallback_preserves_the_real_handshake_without_a_companion() {
        let mut stream = ModelStreamNormalizer::new(ReturnBinding::new("t", 1, "e", true).with_unified_output());
        for event in [
            ModelStreamEvent::ToolCallStarted { index: 0, id: "actual-native-call".into(), name: "read".into() },
            ModelStreamEvent::ToolArgumentsDelta { index: 0, delta: r#"{"path":"book.txt"}"#.into() },
            ModelStreamEvent::ToolCallCompleted { index: 0 },
            ModelStreamEvent::Completed,
        ] {
            assert_eq!(stream.push(event.clone()), vec![event]);
        }
        let mut stream = ModelStreamNormalizer::new(ReturnBinding::new("t", 1, "e", false).with_unified_output());
        assert!(matches!(stream.push(ModelStreamEvent::ToolArgumentsDelta { index: 0, delta: "{}".into() }).as_slice(), [ModelStreamEvent::Failed { .. }]));
    }

    #[test]
    fn unified_typed_value_stream_keeps_json_but_excludes_the_wrapper_and_metadata() {
        for value in [json!("PRIVATE"), json!({"answer":"PRIVATE","execute":true}), json!(false), json!(null)] {
            let mut binding = ReturnBinding::new("t", 1, "e", true).with_unified_output();
            binding.format.id = "morphz.data".into();
            let mut stream = ModelStreamNormalizer::new(binding);
            let raw = json!({"body":value,"effects":[],"annotations":null}).to_string();
            let mut output = String::new();
            for c in raw.chars() {
                collect(stream.push(ModelStreamEvent::TextDelta { text: c.to_string() }), &mut output);
            }
            collect(stream.push(ModelStreamEvent::Completed), &mut output);
            assert_eq!(output, value.to_string());
        }
        let mut stream = ModelStreamNormalizer::new(ReturnBinding::new("t", 1, "e", true).with_unified_output());
        let failure = ModelStreamEvent::Failed { message: "transport interrupted".into() };
        assert_eq!(stream.push(failure.clone()), vec![failure]);
        assert!(stream.push(ModelStreamEvent::Completed).is_empty());
    }

    #[test]
    fn unified_typed_stream_preserves_original_field_order_numbers_and_chunk_boundaries() {
        for value in [r#"{"z": false, "a": 9007199254740993123456789}"#, r#"[false,null,"中文 🌱"]"#, r#""正文\n\"引号\"""#, "null", "false"] {
            for size in [1, 3, 17, 999] {
                let mut binding = ReturnBinding::new("t", 1, "e", true).with_unified_output();
                binding.format.id = "morphz.data".into();
                let mut stream = ModelStreamNormalizer::new(binding);
                let raw = format!("{{\"annotations\":{{\"execution\":{{\"title\":\"PRIVATE METADATA\"}}}},\"body\":{value},\"effects\":[]}}");
                let mut output = String::new();
                for chunk in raw.chars().collect::<Vec<_>>().chunks(size) {
                    collect(stream.push(ModelStreamEvent::TextDelta { text: chunk.iter().collect() }), &mut output);
                }
                let end = stream.push(ModelStreamEvent::Completed);
                assert!(!end.iter().any(|event| matches!(event, ModelStreamEvent::Failed { .. })), "{end:?}");
                collect(end, &mut output);
                assert_eq!(output, value, "size={size}");
            }
        }
    }

    #[test]
    fn optional_annotation_mode_never_changes_or_buffers_ordinary_text() {
        let body = "开头\n{\"body\":\"不是协议\",\"effects\":[]}\n:::morphz-reply\n完整保留";
        for enabled in [false, true] {
            let mut stream = ModelStreamNormalizer::new(ReturnBinding::new("t", 1, "e", enabled));
            for c in body.chars() {
                let text = c.to_string();
                assert_eq!(
                    stream.push(ModelStreamEvent::TextDelta { text: text.clone() }),
                    vec![ModelStreamEvent::TextDelta { text }]
                );
            }
            assert_eq!(
                stream.push(ModelStreamEvent::Completed),
                vec![ModelStreamEvent::Completed]
            );
        }
    }

    #[test]
    fn explicit_typed_json_stream_preserves_the_value_and_can_project_a_parent_string() {
        for enabled in [false, true] {
            let mut binding = ReturnBinding::new("actual-thread", 1, "actual-evaluation", enabled);
            binding.format = crate::session_io::Registry::default()
                .resolve(
                    &crate::session_io::Format::new("morphz.data", "1"),
                    "json",
                    "registered",
                )
                .unwrap()
                .format;
            for value in [
                r#""第一行\n中文 🧠 \"引用\"""#,
                "false",
                "null",
                r#"{"count":9007199254740993123456789,"note":"仅为业务字段"}"#,
                r#"[1,"two",true]"#,
            ] {
                for raw in [
                    [r#"{"delivery_id":"#,&json!(binding.delivery_id).to_string(),r#","message":{"format":{"id":"morphz.data","version":"1"},"content":{"encoding":"json","value":"#,value,"}}}"].concat(),
                    format!("{{\"message\":{{\"content\":{{\"value\":{value},\"encoding\":\"json\"}},\"format\":{{\"version\":\"1\",\"id\":\"morphz.data\"}}}},\"delivery_id\":{}}}",json!(binding.delivery_id)),
                ] {
                    for size in [1,3,17,raw.chars().count()] {
                        let mut stream = ModelStreamNormalizer::new(binding.clone());
                        stream.push(ModelStreamEvent::ToolCallStarted{index:0,id:"typed-value".into(),name:"deliver_message".into()});
                        let mut output=String::new();
                        for chunk in raw.chars().collect::<Vec<_>>().chunks(size) {
                            collect(stream.push(ModelStreamEvent::ToolArgumentsDelta{index:0,delta:chunk.iter().collect()}),&mut output);
                        }
                        assert_eq!(output,value,"size={size}");
                        assert!(stream.push(ModelStreamEvent::ToolCallCompleted{index:0}).is_empty());
                        if value.starts_with('"') {
                            let mut parent=ReplyProjector::new(vec![crate::sexpr_eval::ReplyProjection{path:vec![],conditions:vec![]}],false);
                            let mut shown=String::new();
                            for c in output.chars() {shown.push_str(&parent.push(&c.to_string()).unwrap());}
                            assert_eq!(shown,serde_json::from_str::<String>(value).unwrap());
                        }
                    }
                }
            }
        }
    }
}
