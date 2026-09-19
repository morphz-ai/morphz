//! Comment-preserving source formatter. It never changes literal string contents.

use crate::{parse_all, Diagnostic, Expr, ParseLimits};

pub fn format_source(source: &str) -> Result<String, Diagnostic> {
    let forms = parse_all(source, ParseLimits::default())?;
    let mut output = String::new();
    let mut end = 0;
    for form in &forms {
        comments(&source[end..form.span().start.byte], 0, &mut output);
        if !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        render(form, source, 0, &mut output);
        output.push('\n');
        end = form.span().end.byte;
    }
    comments(&source[end..], 0, &mut output);
    Ok(output)
}

fn comments(gap: &str, indent: usize, output: &mut String) {
    for line in gap.lines() {
        if line.trim_start().starts_with(';') {
            if !output.is_empty() && !output.ends_with('\n') {
                output.push('\n');
            }
            output.push_str(&" ".repeat(indent));
            output.push_str(line.trim());
            output.push('\n');
        }
    }
}

fn compact(expr: &Expr, source: &str) -> Option<String> {
    match expr {
        Expr::Atom(_) => {
            let raw = &source[expr.span().start.byte..expr.span().end.byte];
            (!raw.contains(['\n', '\r'])).then(|| raw.to_string())
        }
        Expr::List { items, span } => {
            let mut end = span.start.byte + 1;
            let mut pieces = Vec::new();
            for item in items {
                if !source[end..item.span().start.byte].trim().is_empty() {
                    return None;
                }
                pieces.push(compact(item, source)?);
                end = item.span().end.byte;
            }
            if !source[end..span.end.byte - 1].trim().is_empty() {
                return None;
            }
            let result = format!("({})", pieces.join(" "));
            (result.chars().count() <= 100).then_some(result)
        }
    }
}

fn render(expr: &Expr, source: &str, indent: usize, output: &mut String) {
    if let Some(value) = compact(expr, source).filter(|value| value.chars().count() + indent <= 100)
    {
        output.push_str(&value);
        return;
    }
    let Expr::List { items, span } = expr else {
        output.push_str(&source[expr.span().start.byte..expr.span().end.byte]);
        return;
    };
    output.push('(');
    let mut end = span.start.byte + 1;
    for (i, item) in items.iter().enumerate() {
        let gap = &source[end..item.span().start.byte];
        let has_comment = gap.contains(';');
        comments(gap, indent + 2, output);
        // Keep the operator and a short leading name together (fn name, bind name...).
        let inline = !has_comment && (i == 0 || (i == 1 && item.as_symbol().is_some()));
        if !inline {
            if !output.ends_with('\n') {
                output.push('\n');
            }
            output.push_str(&" ".repeat(indent + 2));
        } else if i > 0 {
            output.push(' ');
        }
        render(item, source, indent + 2, output);
        end = item.span().end.byte;
    }
    comments(&source[end..span.end.byte - 1], indent + 2, output);
    if output.ends_with('\n') {
        output.push_str(&" ".repeat(indent));
    }
    output.push(')');
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canonical_source;

    #[test]
    fn formatting_preserves_comments_literal_values_identity_and_is_idempotent() {
        let source = " ; header\n(eval ; root\n(seq (bind a \"literal ; not a comment\") ; binding\n(bind b \"\"\"first line\n  second \\\\line \"quoted\".\"\"\")\n ; result\n b)) ; tail\n";
        let result = format_source(source).unwrap();
        assert_eq!(format_source(&result).unwrap(), result);
        let canonical = |s: &str| {
            parse_all(s, ParseLimits::default())
                .unwrap()
                .iter()
                .map(canonical_source)
                .collect::<Vec<_>>()
        };
        assert_eq!(canonical(source), canonical(&result));
        for comment in ["; header", "; root", "; binding", "; result", "; tail"] {
            assert!(result.contains(comment), "lost {comment}");
        }
    }

    #[test]
    fn invalid_source_is_not_repaired_or_written() {
        assert!(format_source("(eval").is_err());
        assert!(format_source("(eval \"\"\"unclosed)").is_err());
    }
}
