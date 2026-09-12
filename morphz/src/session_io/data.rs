//! Bounded, lossless JSON data. Numeric lexemes never pass through a float.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{IoError, IoResult};
use crate::sexpr::SExpr;

/// Explicit tags are the persistence representation, not the external JSON wire.
/// In particular, a stored number remains a string even with a JSONB backend.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum Data {
    Null,
    Boolean(bool),
    Number(String),
    String(String),
    Array(Vec<Data>),
    Object(BTreeMap<String, Data>),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Limits {
    pub max_bytes: usize,
    pub max_depth: usize,
    pub max_nodes: usize,
    pub max_string_bytes: usize,
    pub max_number_bytes: usize,
    pub max_projection_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_bytes: 1024 * 1024,
            max_depth: 32,
            max_nodes: 32_768,
            max_string_bytes: 512 * 1024,
            max_number_bytes: 1024,
            max_projection_bytes: 64 * 1024,
        }
    }
}

impl Data {
    /// For trusted envelope metadata, not raw domain JSON (use `parse` there).
    pub fn from_value(value: &serde_json::Value) -> Self {
        match value {
            serde_json::Value::Null => Self::Null,
            serde_json::Value::Bool(value) => Self::Boolean(*value),
            serde_json::Value::Number(value) => Self::Number(value.to_string()),
            serde_json::Value::String(value) => Self::String(value.clone()),
            serde_json::Value::Array(values) => {
                Self::Array(values.iter().map(Self::from_value).collect())
            }
            serde_json::Value::Object(values) => Self::Object(
                values
                    .iter()
                    .map(|(key, value)| (key.clone(), Self::from_value(value)))
                    .collect(),
            ),
        }
    }
    pub fn parse(bytes: &[u8], limits: &Limits) -> IoResult<Self> {
        if bytes.len() > limits.max_bytes {
            return Err(IoError::new(
                "message_limit_exceeded",
                "JSON exceeds the byte limit",
            ));
        }
        let source = std::str::from_utf8(bytes)
            .map_err(|_| IoError::new("invalid_content_syntax", "JSON must be valid UTF-8"))?;
        let mut parser = Parser {
            source,
            at: 0,
            nodes: 0,
            limits,
        };
        let value = parser.value(0)?;
        parser.space();
        if parser.at != source.len() {
            return Err(parser.syntax());
        }
        Ok(value)
    }

    /// Canonical object order, original array order and original number lexemes.
    pub fn json(&self) -> String {
        match self {
            Self::Null => "null".into(),
            Self::Boolean(value) => value.to_string(),
            Self::Number(value) => value.clone(),
            Self::String(value) => serde_json::to_string(value).expect("string serialization"),
            Self::Array(values) => format!(
                "[{}]",
                values.iter().map(Self::json).collect::<Vec<_>>().join(",")
            ),
            Self::Object(values) => format!(
                "{{{}}}",
                values
                    .iter()
                    .map(|(key, value)| {
                        format!(
                            "{}:{}",
                            serde_json::to_string(key).expect("string serialization"),
                            value.json()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",")
            ),
        }
    }

    pub fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Object(values) => values.get(key),
            _ => None,
        }
    }

    pub fn string(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value),
            _ => None,
        }
    }

    pub fn object(&self) -> IoResult<&BTreeMap<String, Self>> {
        match self {
            Self::Object(value) => Ok(value),
            _ => Err(IoError::new("invalid_content_syntax", "Expected an object")),
        }
    }

    /// A typed tree, never parse client data as S-expression source.
    pub fn expression(&self) -> SExpr {
        fn node(name: &str, children: Vec<SExpr>) -> SExpr {
            SExpr::List(
                std::iter::once(SExpr::Atom(name.into()))
                    .chain(children)
                    .collect(),
            )
        }
        match self {
            Self::Null => node("null", vec![]),
            Self::Boolean(value) => node("boolean", vec![SExpr::Atom(value.to_string())]),
            Self::Number(value) => node("number", vec![SExpr::Atom(value.clone())]),
            Self::String(value) => node("string", vec![SExpr::Atom(value.clone())]),
            Self::Array(values) => node("array", values.iter().map(Self::expression).collect()),
            Self::Object(values) => node(
                "object",
                values
                    .iter()
                    .map(|(key, value)| {
                        node(
                            "entry",
                            vec![
                                node("string", vec![SExpr::Atom(key.clone())]),
                                value.expression(),
                            ],
                        )
                    })
                    .collect(),
            ),
        }
    }
}

struct Parser<'a> {
    source: &'a str,
    at: usize,
    nodes: usize,
    limits: &'a Limits,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.source.as_bytes().get(self.at).copied()
    }
    fn space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.at += 1;
        }
    }
    fn syntax(&self) -> IoError {
        IoError::new(
            "invalid_content_syntax",
            format!("Invalid JSON at byte {}", self.at),
        )
    }
    fn consume(&mut self, byte: u8) -> IoResult<()> {
        self.space();
        if self.peek() != Some(byte) {
            return Err(self.syntax());
        }
        self.at += 1;
        Ok(())
    }
    fn string(&mut self) -> IoResult<String> {
        self.consume(b'"')?;
        let start = self.at - 1;
        loop {
            if self.at - start > self.limits.max_string_bytes {
                return Err(IoError::new(
                    "message_limit_exceeded",
                    "JSON string exceeds limit",
                ));
            }
            match self.peek() {
                Some(b'"') => {
                    self.at += 1;
                    return serde_json::from_str(&self.source[start..self.at])
                        .map_err(|_| self.syntax());
                }
                Some(b'\\') => {
                    self.at += 1;
                    if self.peek().is_none() {
                        return Err(self.syntax());
                    }
                    self.at += 1;
                }
                Some(0..=31) | None => return Err(self.syntax()),
                Some(_) => self.at += 1,
            }
        }
    }
    fn value(&mut self, depth: usize) -> IoResult<Data> {
        self.space();
        self.nodes += 1;
        if depth > self.limits.max_depth || self.nodes > self.limits.max_nodes {
            return Err(IoError::new(
                "message_limit_exceeded",
                "JSON nesting or node count exceeds limit",
            ));
        }
        match self.peek() {
            Some(b'"') => self.string().map(Data::String),
            Some(b'{') => {
                self.at += 1;
                self.space();
                let mut values = BTreeMap::new();
                if self.peek() == Some(b'}') {
                    self.at += 1;
                    return Ok(Data::Object(values));
                }
                loop {
                    let key = self.string()?;
                    if values.contains_key(&key) {
                        return Err(IoError::new(
                            "invalid_content_syntax",
                            "Duplicate JSON object key",
                        ));
                    }
                    self.consume(b':')?;
                    values.insert(key, self.value(depth + 1)?);
                    self.space();
                    if self.peek() == Some(b'}') {
                        self.at += 1;
                        return Ok(Data::Object(values));
                    }
                    self.consume(b',')?;
                }
            }
            Some(b'[') => {
                self.at += 1;
                self.space();
                let mut values = Vec::new();
                if self.peek() == Some(b']') {
                    self.at += 1;
                    return Ok(Data::Array(values));
                }
                loop {
                    values.push(self.value(depth + 1)?);
                    self.space();
                    if self.peek() == Some(b']') {
                        self.at += 1;
                        return Ok(Data::Array(values));
                    }
                    self.consume(b',')?;
                }
            }
            Some(b'n' | b't' | b'f') => {
                for (literal, value) in [
                    ("null", Data::Null),
                    ("true", Data::Boolean(true)),
                    ("false", Data::Boolean(false)),
                ] {
                    if self.source[self.at..].starts_with(literal) {
                        self.at += literal.len();
                        return Ok(value);
                    }
                }
                Err(self.syntax())
            }
            Some(b'-' | b'0'..=b'9') => {
                let start = self.at;
                if self.peek() == Some(b'-') {
                    self.at += 1;
                }
                match self.peek() {
                    Some(b'0') => self.at += 1,
                    Some(b'1'..=b'9') => {
                        while matches!(self.peek(), Some(b'0'..=b'9')) {
                            self.at += 1;
                        }
                    }
                    _ => return Err(self.syntax()),
                }
                if self.peek() == Some(b'.') {
                    self.at += 1;
                    self.digits()?;
                }
                if matches!(self.peek(), Some(b'e' | b'E')) {
                    self.at += 1;
                    if matches!(self.peek(), Some(b'+' | b'-')) {
                        self.at += 1;
                    }
                    self.digits()?;
                }
                if self.at - start > self.limits.max_number_bytes {
                    return Err(IoError::new(
                        "message_limit_exceeded",
                        "JSON number exceeds limit",
                    ));
                }
                Ok(Data::Number(self.source[start..self.at].into()))
            }
            _ => Err(self.syntax()),
        }
    }
    fn digits(&mut self) -> IoResult<()> {
        let start = self.at;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.at += 1;
        }
        if self.at == start {
            return Err(self.syntax());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lossless_numbers_canonical_objects_and_inert_strings() {
        let data = Data::parse(
            br#"{"z":900719925474099312345,"a":[1,1.0,-0,1e999,"(kernel x)"]}"#,
            &Limits::default(),
        )
        .unwrap();
        assert_eq!(
            data.json(),
            r#"{"a":[1,1.0,-0,1e999,"(kernel x)"],"z":900719925474099312345}"#
        );
        let stored = serde_json::to_value(&data).unwrap();
        assert_eq!(serde_json::from_value::<Data>(stored).unwrap(), data);
        assert!(data
            .expression()
            .to_string()
            .contains("(string \"(kernel x)\")"));
    }
    #[test]
    fn rejects_duplicate_keys_invalid_unicode_and_non_json_numbers() {
        for source in [
            r#"{"a":1,"\u0061":2}"#,
            r#""\ud800""#,
            "NaN",
            "01",
            "1.",
            "1e",
            "[1,]",
            "true false",
        ] {
            assert!(
                Data::parse(source.as_bytes(), &Limits::default()).is_err(),
                "{source}"
            );
        }
        let limits = Limits {
            max_depth: 2,
            ..Limits::default()
        };
        assert!(Data::parse(b"[[[[]]]]", &limits).is_err());
    }
}
