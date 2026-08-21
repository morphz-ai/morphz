use serde::{Deserialize, Serialize};

/// Stable machine-readable diagnostic family.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticCode {
    InvalidCharacter,
    InvalidEscape,
    UnterminatedString,
    UnexpectedClose,
    UnclosedList,
    EmptyInput,
    MultipleTopLevelForms,
    NestingLimit,
    SourceLimit,
    InvalidType,
    DuplicateName,
    RecursiveType,
    TypeMismatch,
    UnknownName,
    UnknownOperator,
    EffectEscape,
    ResourceLimit,
}

/// One position in UTF-8 source. `byte` is zero-based; line and column are one-based Unicode
/// scalar positions for display.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SourceLocation {
    pub byte: usize,
    pub line: usize,
    pub column: usize,
}

impl SourceLocation {
    pub const fn start() -> Self {
        Self {
            byte: 0,
            line: 1,
            column: 1,
        }
    }
}

/// Half-open source range `[start.byte, end.byte)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SourceSpan {
    pub start: SourceLocation,
    pub end: SourceLocation,
}

impl SourceSpan {
    pub const fn empty(at: SourceLocation) -> Self {
        Self { start: at, end: at }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub code: DiagnosticCode,
    pub message: String,
    pub primary: SourceSpan,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub related: Vec<SourceSpan>,
}

impl Diagnostic {
    pub fn new(code: DiagnosticCode, message: impl Into<String>, primary: SourceSpan) -> Self {
        Self {
            code,
            message: message.into(),
            primary,
            related: Vec::new(),
        }
    }

    pub fn with_related(mut self, span: SourceSpan) -> Self {
        self.related.push(span);
        self
    }
}

impl std::fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{:?} at {}:{}: {}",
            self.code, self.primary.start.line, self.primary.start.column, self.message
        )
    }
}

impl std::error::Error for Diagnostic {}
