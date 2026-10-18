//! One explicit metadata header for ordinary assistant text. Never infer
//! metadata from business JSON keys, Markdown, or text inside the response body.
use super::Diagnostic;
use serde_json::Value;

pub const OPEN: &str = "<morphz-annotations>";
pub const CLOSE: &str = "</morphz-annotations>";
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_LEADING_WHITESPACE: usize = 64;

#[derive(Default)]
enum State {
    #[default]
    Prefix,
    Header,
    Separator,
    Body,
}

/// Only the bounded initial header is buffered. After it, body deltas pass
/// through immediately and byte-for-byte, including literal metadata examples.
#[derive(Default)]
pub struct TextAnnotationDecoder {
    state: State,
    pending: String,
    pub annotations: Option<Value>,
    pub diagnostics: Vec<Diagnostic>,
}

impl TextAnnotationDecoder {
    pub fn push(&mut self, delta: &str) -> String {
        if matches!(self.state, State::Body) {
            return delta.into();
        }
        // A single provider event may contain the complete large body. Probe
        // only the bounded prefix, then pass the remainder without buffering it.
        let capacity = MAX_HEADER_BYTES.saturating_sub(self.pending.len());
        let mut boundary = delta.len().min(capacity);
        while !delta.is_char_boundary(boundary) {
            boundary -= 1;
        }
        self.pending.push_str(&delta[..boundary]);
        let mut output = self.advance();
        if boundary < delta.len() {
            if !matches!(self.state, State::Body) {
                self.note("Annotation header exceeds its byte budget; original text preserved");
                output.push_str(&self.release());
            }
            output.push_str(&delta[boundary..]);
        }
        output
    }

    fn advance(&mut self) -> String {
        if matches!(self.state, State::Prefix) {
            let prefix = self.pending.trim_start_matches([' ', '\t', '\r', '\n']);
            let leading = self.pending.len() - prefix.len();
            if leading > MAX_LEADING_WHITESPACE {
                return self.release();
            }
            if prefix.starts_with(OPEN) {
                self.state = State::Header;
            } else if !OPEN.starts_with(prefix) {
                return self.release();
            } else {
                return String::new();
            }
        }
        if matches!(self.state, State::Header) {
            let start = self.pending.find(OPEN).expect("validated header prefix") + OPEN.len();
            let Some(relative_end) = header_end(&self.pending[start..]) else {
                return String::new();
            };
            let end = start + relative_end;
            match serde_json::from_str(&self.pending[start..end]) {
                Ok(value) => self.annotations = Some(value),
                Err(_) => self.note("Invalid annotation header JSON; body remains valid"),
            }
            self.pending.drain(..end + CLOSE.len());
            self.state = State::Separator;
        }
        if matches!(self.state, State::Separator) {
            if self.pending.is_empty() || self.pending == "\r" {
                return String::new();
            }
            if self.pending.starts_with("\r\n") {
                self.pending.drain(..2);
            } else if self.pending.starts_with('\n') {
                self.pending.drain(..1);
            }
            return self.release();
        }
        String::new()
    }

    fn note(&mut self, message: &str) {
        self.diagnostics.push(Diagnostic {
            path: "content.annotations".into(),
            message: message.into(),
        });
    }

    fn release(&mut self) -> String {
        self.state = State::Body;
        std::mem::take(&mut self.pending)
    }

    pub fn finish(&mut self) -> String {
        if matches!(self.state, State::Header) {
            self.note("Unterminated annotation header; original text preserved");
        }
        self.release()
    }
}

// A marker quoted inside a metadata JSON string is data, not the end of the
// envelope. The full JSON parser remains authoritative after this lexical cut.
fn header_end(text: &str) -> Option<usize> {
    let mut quoted = false;
    let mut escaped = false;
    for (index, character) in text.char_indices() {
        if quoted {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                quoted = false;
            }
        } else if character == '"' {
            quoted = true;
        } else if character == '<' && text[index..].starts_with(CLOSE) {
            return Some(index);
        }
    }
    None
}

pub fn decode(content: &str) -> (String, Option<Value>, Vec<Diagnostic>) {
    let mut decoder = TextAnnotationDecoder::default();
    let mut body = decoder.push(content);
    body.push_str(&decoder.finish());
    (body, decoder.annotations, decoder.diagnostics)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_unicode_split_has_same_metadata_and_exact_early_body() {
        let annotations = json!({"execution":{"title":"核对🧠","result":"已检查 </morphz-annotations> 与转义引号 \""}});
        let body = "中文 🧠\n\n```json\n{\"annotations\":\"业务值\"}\n```";
        for separator in ["\n", "\r\n"] {
            let raw = format!("{OPEN}{annotations}{CLOSE}{separator}{body}");
            for split in raw.char_indices().map(|(i, _)| i).chain([raw.len()]) {
                let mut decoder = TextAnnotationDecoder::default();
                let first = decoder.push(&raw[..split]);
                let second = decoder.push(&raw[split..]);
                assert_eq!(format!("{first}{second}{}", decoder.finish()), body);
                assert_eq!(decoder.annotations, Some(annotations.clone()));
            }
        }
        let mut decoder = TextAnnotationDecoder::default();
        assert_eq!(
            decoder.push(&format!("{OPEN}{annotations}{CLOSE}\n已经到达")),
            "已经到达"
        );
        assert_eq!(decoder.push("，还在生成"), "，还在生成");
    }

    #[test]
    fn ordinary_data_and_body_examples_are_never_guessed_as_metadata() {
        for raw in [
            "普通正文\n<morphz-annotations>{}</morphz-annotations>",
            "```xml\n<morphz-annotations>{}</morphz-annotations>\n```",
            r#"{"content":"业务","annotations":{"execution":{"title":"业务值"}}}"#,
            "<morphz-annotation>",
            "<mor",
            "  \n正文",
        ] {
            let (body, annotations, diagnostics) = decode(raw);
            assert_eq!(body, raw);
            assert!(annotations.is_none());
            assert!(diagnostics.is_empty());
        }
    }

    #[test]
    fn malformed_or_incomplete_metadata_never_hides_a_nonempty_reply() {
        let (body, metadata, diagnostics) = decode(&format!("{OPEN}{{bad}}{CLOSE}\n正文"));
        assert_eq!(body, "正文");
        assert!(metadata.is_none());
        assert_eq!(diagnostics.len(), 1);
        for raw in [
            format!("{OPEN}{{未闭合\n正文"),
            format!("{OPEN}{}正文", "x".repeat(MAX_HEADER_BYTES)),
        ] {
            let (body, metadata, diagnostics) = decode(&raw);
            assert_eq!(body, raw);
            assert!(metadata.is_none());
            assert_eq!(diagnostics.len(), 1);
        }
        let body = "长正文🧠".repeat(100_000);
        assert_eq!(decode(&format!("{OPEN}{{}}{CLOSE}\n{body}")).0, body);
    }
}
