use serde::{Deserialize, Serialize};

use crate::diagnostic::{Diagnostic, DiagnosticCode, SourceLocation, SourceSpan};

pub const DEFAULT_MAX_SOURCE_BYTES: usize = 256 * 1024;
pub const DEFAULT_MAX_NESTING: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseLimits {
    pub max_source_bytes: usize,
    pub max_nesting: usize,
}

impl Default for ParseLimits {
    fn default() -> Self {
        Self {
            max_source_bytes: DEFAULT_MAX_SOURCE_BYTES,
            max_nesting: DEFAULT_MAX_NESTING,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AtomKind {
    Symbol,
    String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Atom {
    pub kind: AtomKind,
    pub value: String,
    pub span: SourceSpan,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Expr {
    Atom(Atom),
    List { items: Vec<Expr>, span: SourceSpan },
}

impl Expr {
    pub const fn span(&self) -> SourceSpan {
        match self {
            Self::Atom(atom) => atom.span,
            Self::List { span, .. } => *span,
        }
    }

    pub fn as_symbol(&self) -> Option<&str> {
        match self {
            Self::Atom(Atom {
                kind: AtomKind::Symbol,
                value,
                ..
            }) => Some(value),
            _ => None,
        }
    }

    pub fn as_list(&self) -> Option<&[Expr]> {
        match self {
            Self::List { items, .. } => Some(items),
            Self::Atom(_) => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TokenKind {
    Open,
    Close,
    Atom(AtomKind, String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Token {
    kind: TokenKind,
    span: SourceSpan,
}

struct Lexer<'a> {
    source: &'a str,
    cursor: usize,
    location: SourceLocation,
}

impl<'a> Lexer<'a> {
    fn new(source: &'a str) -> Self {
        Self {
            source,
            cursor: 0,
            location: SourceLocation::start(),
        }
    }

    fn peek(&self) -> Option<char> {
        self.source.get(self.cursor..)?.chars().next()
    }

    fn bump(&mut self) -> Option<char> {
        let value = self.peek()?;
        self.cursor += value.len_utf8();
        self.location.byte = self.cursor;
        if value == '\n' {
            self.location.line += 1;
            self.location.column = 1;
        } else {
            self.location.column += 1;
        }
        Some(value)
    }

    fn skip_trivia(&mut self) {
        loop {
            while self.peek().is_some_and(char::is_whitespace) {
                self.bump();
            }
            if self.peek() != Some(';') {
                return;
            }
            while self.peek().is_some_and(|value| value != '\n') {
                self.bump();
            }
        }
    }

    fn next_token(&mut self) -> Result<Option<Token>, Diagnostic> {
        self.skip_trivia();
        let start = self.location;
        let Some(current) = self.peek() else {
            return Ok(None);
        };
        match current {
            '(' => {
                self.bump();
                Ok(Some(Token {
                    kind: TokenKind::Open,
                    span: SourceSpan {
                        start,
                        end: self.location,
                    },
                }))
            }
            ')' => {
                self.bump();
                Ok(Some(Token {
                    kind: TokenKind::Close,
                    span: SourceSpan {
                        start,
                        end: self.location,
                    },
                }))
            }
            '"' => self.string_token(start).map(Some),
            _ => self.symbol_token(start).map(Some),
        }
    }

    fn string_token(&mut self, start: SourceLocation) -> Result<Token, Diagnostic> {
        self.bump();
        let mut value = String::new();
        loop {
            match self.bump() {
                Some('"') => {
                    return Ok(Token {
                        kind: TokenKind::Atom(AtomKind::String, value),
                        span: SourceSpan {
                            start,
                            end: self.location,
                        },
                    })
                }
                Some('\\') => {
                    let escape_start = SourceLocation {
                        byte: self.location.byte.saturating_sub(1),
                        line: self.location.line,
                        column: self.location.column.saturating_sub(1),
                    };
                    let escaped = match self.bump() {
                        Some('\\') => '\\',
                        Some('"') => '"',
                        Some('n') => '\n',
                        Some('r') => '\r',
                        Some('t') => '\t',
                        Some(other) => {
                            return Err(Diagnostic::new(
                                DiagnosticCode::InvalidEscape,
                                format!("unknown string escape '\\{other}'"),
                                SourceSpan {
                                    start: escape_start,
                                    end: self.location,
                                },
                            ))
                        }
                        None => {
                            return Err(Diagnostic::new(
                                DiagnosticCode::UnterminatedString,
                                "unterminated string after escape",
                                SourceSpan {
                                    start,
                                    end: self.location,
                                },
                            ))
                        }
                    };
                    value.push(escaped);
                }
                Some('\n' | '\r') => {
                    return Err(Diagnostic::new(
                        DiagnosticCode::UnterminatedString,
                        "unescaped newline in string literal",
                        SourceSpan {
                            start,
                            end: self.location,
                        },
                    ))
                }
                Some(value_char) => value.push(value_char),
                None => {
                    return Err(Diagnostic::new(
                        DiagnosticCode::UnterminatedString,
                        "unterminated string literal",
                        SourceSpan {
                            start,
                            end: self.location,
                        },
                    ))
                }
            }
        }
    }

    fn symbol_token(&mut self, start: SourceLocation) -> Result<Token, Diagnostic> {
        let begin = self.cursor;
        while self
            .peek()
            .is_some_and(|value| !value.is_whitespace() && !matches!(value, '(' | ')' | ';' | '"'))
        {
            self.bump();
        }
        if begin == self.cursor {
            self.bump();
            return Err(Diagnostic::new(
                DiagnosticCode::InvalidCharacter,
                format!("unexpected character at byte {}", start.byte),
                SourceSpan {
                    start,
                    end: self.location,
                },
            ));
        }
        Ok(Token {
            kind: TokenKind::Atom(
                AtomKind::Symbol,
                self.source[begin..self.cursor].to_string(),
            ),
            span: SourceSpan {
                start,
                end: self.location,
            },
        })
    }
}

struct ListBuilder {
    open_span: SourceSpan,
    items: Vec<Expr>,
}

pub fn parse_all(source: &str, limits: ParseLimits) -> Result<Vec<Expr>, Diagnostic> {
    if source.len() > limits.max_source_bytes {
        return Err(Diagnostic::new(
            DiagnosticCode::SourceLimit,
            format!(
                "source contains {} bytes; the limit is {}",
                source.len(),
                limits.max_source_bytes
            ),
            SourceSpan::empty(SourceLocation::start()),
        ));
    }

    let mut lexer = Lexer::new(source);
    let mut stack = Vec::<ListBuilder>::new();
    let mut forms = Vec::<Expr>::new();
    while let Some(token) = lexer.next_token()? {
        match token.kind {
            TokenKind::Open => {
                if stack.len() >= limits.max_nesting {
                    return Err(Diagnostic::new(
                        DiagnosticCode::NestingLimit,
                        format!("syntax nesting exceeds {}", limits.max_nesting),
                        token.span,
                    ));
                }
                stack.push(ListBuilder {
                    open_span: token.span,
                    items: Vec::new(),
                });
            }
            TokenKind::Close => {
                let Some(builder) = stack.pop() else {
                    return Err(Diagnostic::new(
                        DiagnosticCode::UnexpectedClose,
                        "unexpected closing parenthesis",
                        token.span,
                    ));
                };
                let expression = Expr::List {
                    items: builder.items,
                    span: SourceSpan {
                        start: builder.open_span.start,
                        end: token.span.end,
                    },
                };
                push_expression(&mut stack, &mut forms, expression);
            }
            TokenKind::Atom(kind, value) => push_expression(
                &mut stack,
                &mut forms,
                Expr::Atom(Atom {
                    kind,
                    value,
                    span: token.span,
                }),
            ),
        }
    }
    if let Some(builder) = stack.first() {
        return Err(Diagnostic::new(
            DiagnosticCode::UnclosedList,
            "unclosed list",
            SourceSpan {
                start: builder.open_span.start,
                end: lexer.location,
            },
        ));
    }
    Ok(forms)
}

pub fn parse_one(source: &str, limits: ParseLimits) -> Result<Expr, Diagnostic> {
    let forms = parse_all(source, limits)?;
    match forms.as_slice() {
        [] => Err(Diagnostic::new(
            DiagnosticCode::EmptyInput,
            "expected one top-level artifact",
            SourceSpan::empty(SourceLocation::start()),
        )),
        [form] => Ok(form.clone()),
        [first, rest @ ..] => Err(Diagnostic::new(
            DiagnosticCode::MultipleTopLevelForms,
            format!("expected one top-level artifact, found {}", forms.len()),
            rest.first().map_or(first.span(), Expr::span),
        )
        .with_related(first.span())),
    }
}

fn push_expression(stack: &mut [ListBuilder], forms: &mut Vec<Expr>, expression: Expr) {
    if let Some(parent) = stack.last_mut() {
        parent.items.push(expression);
    } else {
        forms.push(expression);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retains_atom_kind_and_precise_multibyte_spans() {
        let source = "(eval\n  ; 中文注释\n  (seq \"爻文\" symbol))";
        let root = parse_one(source, ParseLimits::default()).unwrap();
        let Expr::List { items, span } = root else {
            panic!("expected root list")
        };
        assert_eq!(span.start, SourceLocation::start());
        assert_eq!(span.end.byte, source.len());
        let Expr::List { items: seq, .. } = &items[1] else {
            panic!("expected seq")
        };
        let Expr::Atom(string) = &seq[1] else {
            panic!("expected string")
        };
        assert_eq!(string.kind, AtomKind::String);
        assert_eq!(string.value, "爻文");
        assert_eq!(string.span.start.line, 3);
        assert_eq!(string.span.start.column, 8);
        assert_eq!(seq[2].as_symbol(), Some("symbol"));
    }

    #[test]
    fn decodes_only_the_declared_string_escapes() {
        let expression = parse_one(r#""a\\b\"c\nd\re\tf""#, ParseLimits::default()).unwrap();
        let Expr::Atom(atom) = expression else {
            panic!("expected atom")
        };
        assert_eq!(atom.value, "a\\b\"c\nd\re\tf");
        assert_eq!(atom.kind, AtomKind::String);

        let error = parse_one(r#""bad\x""#, ParseLimits::default()).unwrap_err();
        assert_eq!(error.code, DiagnosticCode::InvalidEscape);
    }

    #[test]
    fn rejects_unbalanced_and_multiple_top_level_forms() {
        assert_eq!(
            parse_one("(eval", ParseLimits::default()).unwrap_err().code,
            DiagnosticCode::UnclosedList
        );
        assert_eq!(
            parse_one("(eval))", ParseLimits::default())
                .unwrap_err()
                .code,
            DiagnosticCode::UnexpectedClose
        );
        assert_eq!(
            parse_one("(eval nil) (infer \"x\")", ParseLimits::default())
                .unwrap_err()
                .code,
            DiagnosticCode::MultipleTopLevelForms
        );
    }

    #[test]
    fn enforces_source_and_nesting_limits_before_semantics() {
        assert_eq!(
            parse_one(
                "12345",
                ParseLimits {
                    max_source_bytes: 4,
                    max_nesting: 4,
                }
            )
            .unwrap_err()
            .code,
            DiagnosticCode::SourceLimit
        );
        assert_eq!(
            parse_one(
                "((()))",
                ParseLimits {
                    max_source_bytes: 64,
                    max_nesting: 2,
                }
            )
            .unwrap_err()
            .code,
            DiagnosticCode::NestingLimit
        );
    }

    #[test]
    fn arbitrary_short_inputs_never_panic() {
        let alphabet = ['(', ')', '"', '\\', ';', '\n', 'a', '爻'];
        for seed in 0_u64..4_096 {
            let mut state = seed.wrapping_add(1);
            let mut input = String::new();
            for _ in 0..(seed as usize % 48) {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1);
                input.push(alphabet[(state as usize) % alphabet.len()]);
            }
            let _ = parse_all(
                &input,
                ParseLimits {
                    max_source_bytes: 256,
                    max_nesting: 16,
                },
            );
        }
    }
}
