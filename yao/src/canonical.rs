use sha2::{Digest, Sha256};

use crate::sema::Program;
use crate::syntax::{AtomKind, Expr};

/// Canonical concrete encoding used for syntax fixtures and as an input to the later typed
/// canonical representation. Comments, source spans, and insignificant whitespace are omitted.
pub fn canonical_source(expression: &Expr) -> String {
    let mut output = String::new();
    let mut tasks = vec![Task::Expr(expression)];
    while let Some(task) = tasks.pop() {
        match task {
            Task::Expr(Expr::Atom(atom)) => match atom.kind {
                AtomKind::Symbol => output.push_str(&atom.value),
                AtomKind::String => push_string(&mut output, &atom.value),
            },
            Task::Expr(Expr::List { items, .. }) => {
                output.push('(');
                tasks.push(Task::Close);
                for (index, item) in items.iter().enumerate().rev() {
                    tasks.push(Task::Expr(item));
                    if index > 0 {
                        tasks.push(Task::Space);
                    }
                }
            }
            Task::Space => output.push(' '),
            Task::Close => output.push(')'),
        }
    }
    output
}

pub fn content_hash(expression: &Expr) -> String {
    format!(
        "sha256:{:x}",
        Sha256::digest(canonical_source(expression).as_bytes())
    )
}

/// Canonical encoding of the admitted typed artifact.
///
/// Source spans and the original concrete spelling are provenance, not identity. Dictionary
/// entries are sorted because their insertion order has no Yao semantics. Other arrays retain
/// their order: this includes `seq`, arguments with repeated values, and `par` branches.
pub fn canonical_program(program: &Program) -> String {
    let mut value = serde_json::to_value(program).expect("Yao Program serialization is infallible");
    normalize_typed_identity(&mut value);
    serde_json::to_string(&value).expect("canonical Yao Program JSON is serializable")
}

pub fn program_hash(program: &Program) -> String {
    format!(
        "sha256:{:x}",
        Sha256::digest(canonical_program(program).as_bytes())
    )
}

fn normalize_typed_identity(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Array(values) => {
            for value in values.iter_mut() {
                normalize_typed_identity(value);
            }
        }
        serde_json::Value::Object(fields) => {
            fields.remove("span");
            fields.remove("canonical_source");
            fields.remove("source_hash");
            for value in fields.values_mut() {
                normalize_typed_identity(value);
            }
            if fields.get("op").and_then(serde_json::Value::as_str) == Some("dict") {
                if let Some(entries) = fields
                    .get_mut("entries")
                    .and_then(serde_json::Value::as_array_mut)
                {
                    entries.sort_by(|left, right| {
                        left.get(0)
                            .and_then(serde_json::Value::as_str)
                            .cmp(&right.get(0).and_then(serde_json::Value::as_str))
                    });
                }
            }
        }
        _ => {}
    }
}

enum Task<'a> {
    Expr(&'a Expr),
    Space,
    Close,
}

fn push_string(output: &mut String, value: &str) {
    output.push('"');
    for character in value.chars() {
        match character {
            '\\' => output.push_str("\\\\"),
            '"' => output.push_str("\\\""),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            other => output.push(other),
        }
    }
    output.push('"');
}

#[cfg(test)]
mod tests {
    use crate::sema::{analyze, AnalysisLimits, StaticProfile};
    use crate::syntax::{parse_one, ParseLimits};

    use super::*;

    #[test]
    fn whitespace_comments_and_source_location_do_not_change_identity() {
        let left = parse_one(
            "(eval ; ignored\n (seq \"a\" symbol))",
            ParseLimits::default(),
        )
        .unwrap();
        let right = parse_one("  ( eval ( seq \"a\" symbol ) ) ", ParseLimits::default()).unwrap();
        assert_eq!(canonical_source(&left), "(eval (seq \"a\" symbol))");
        assert_eq!(canonical_source(&left), canonical_source(&right));
        assert_eq!(content_hash(&left), content_hash(&right));
    }

    #[test]
    fn string_and_symbol_identity_are_distinct() {
        let string = parse_one("\"true\"", ParseLimits::default()).unwrap();
        let symbol = parse_one("true", ParseLimits::default()).unwrap();
        assert_ne!(canonical_source(&string), canonical_source(&symbol));
        assert_ne!(content_hash(&string), content_hash(&symbol));
    }

    #[test]
    fn canonical_form_round_trips() {
        let source = r#"(eval (seq "a\\b\nc" (list 1 true nil)))"#;
        let first = parse_one(source, ParseLimits::default()).unwrap();
        let canonical = canonical_source(&first);
        let second = parse_one(&canonical, ParseLimits::default()).unwrap();
        assert_eq!(canonical_source(&second), canonical);
        assert_eq!(content_hash(&second), content_hash(&first));
    }

    #[test]
    fn typed_identity_ignores_spans_comments_and_dict_insertion_order() {
        let left = analyze(
            r#"(eval (version "0.1") (dict (b 2) (a 1)))"#,
            &StaticProfile::default(),
            AnalysisLimits::default(),
        )
        .unwrap();
        let right = analyze(
            r#"
              ; provenance changes, meaning does not
              (eval (version "0.1")
                (dict (a 1) (b 2)))
            "#,
            &StaticProfile::default(),
            AnalysisLimits::default(),
        )
        .unwrap();
        assert_eq!(canonical_program(&left), canonical_program(&right));
        assert_eq!(program_hash(&left), program_hash(&right));
    }

    #[test]
    fn typed_identity_preserves_parallel_source_order() {
        let left = analyze(
            r#"(eval (version "0.1") (par (branch a 1) (branch b 2)))"#,
            &StaticProfile::default(),
            AnalysisLimits::default(),
        )
        .unwrap();
        let right = analyze(
            r#"(eval (version "0.1") (par (branch b 2) (branch a 1)))"#,
            &StaticProfile::default(),
            AnalysisLimits::default(),
        )
        .unwrap();
        assert_ne!(program_hash(&left), program_hash(&right));
    }
}
