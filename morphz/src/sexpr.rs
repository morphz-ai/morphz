#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SExpr {
    Atom(String),
    List(Vec<SExpr>),
}

/// Global syntactic safety boundary for every S-expression accepted by the
/// Runtime. Individual evaluators may impose a stricter semantic limit (Yao,
/// for example, permits substantially less nesting), but parsing must reject
/// hostile input before recursive tree construction can exhaust a worker
/// thread's stack.
pub const MAX_SEXPR_NESTING_DEPTH: usize = 128;

impl std::fmt::Display for SExpr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        enum Task<'a> {
            Value(&'a SExpr),
            Space,
            CloseList,
        }

        let mut tasks = vec![Task::Value(self)];
        while let Some(task) = tasks.pop() {
            match task {
                Task::Value(SExpr::Atom(s)) => {
                    // Quote and escape values containing whitespace, parentheses, double quotes,
                    // newlines, or other syntax-sensitive characters.
                    if s.contains(' ')
                        || s.contains('(')
                        || s.contains(')')
                        || s.contains('\'')
                        || s.contains('\n')
                        || s.contains('\r')
                        || s.contains('\t')
                        || s.contains('"')
                        || s.is_empty()
                    {
                        write!(f, "\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))?;
                    } else {
                        f.write_str(s)?;
                    }
                }
                Task::Value(SExpr::List(items)) => {
                    f.write_str("(")?;
                    tasks.push(Task::CloseList);
                    for (index, item) in items.iter().enumerate().rev() {
                        tasks.push(Task::Value(item));
                        if index > 0 {
                            tasks.push(Task::Space);
                        }
                    }
                }
                Task::Space => f.write_str(" ")?,
                Task::CloseList => f.write_str(")")?,
            }
        }
        Ok(())
    }
}

impl SExpr {
    // Finds a child value by path, e.g. `["variables", "current_file"]`.
    pub fn get_path(&self, path: &[&str]) -> Option<&SExpr> {
        if path.is_empty() {
            return Some(self);
        }
        match self {
            SExpr::List(list) => {
                let key = path[0];
                if let Some(idx) = find_sub_idx_in_list(list, key) {
                    let sub_node = &list[idx];
                    if path.len() == 1 {
                        if let SExpr::List(sub_list) = sub_node {
                            if sub_list.len() == 2 {
                                return Some(&sub_list[1]);
                            }
                        }
                        return Some(sub_node);
                    } else {
                        return sub_node.get_path(&path[1..]);
                    }
                }
                None
            }
            _ => None,
        }
    }

    // Finds and mutably borrows a child by path, e.g. `["variables", "current_file"]`.
    pub fn get_path_mut(&mut self, path: &[&str]) -> Option<&mut SExpr> {
        if path.is_empty() {
            return Some(self);
        }
        match self {
            SExpr::List(ref mut list) => {
                let key = path[0];
                if let Some(idx) = find_sub_idx_in_list(list, key) {
                    if path.len() == 1 {
                        return Some(&mut list[idx]);
                    } else {
                        return list[idx].get_path_mut(&path[1..]);
                    }
                }
                None
            }
            _ => None,
        }
    }

    // Sets or replaces a child by path, creating missing path segments automatically.
    pub fn set_path(&mut self, path: &[&str], value: SExpr) -> Result<(), String> {
        if path.is_empty() {
            return Err("path must not be empty".to_string());
        }
        match self {
            SExpr::List(ref mut list) => {
                if list.is_empty() {
                    return Err("cannot set_path on an empty List node".to_string());
                }
                let key = path[0];
                if let Some(idx) = find_sub_idx_in_list(list, key) {
                    if path.len() == 1 {
                        list[idx] = SExpr::List(vec![SExpr::Atom(key.to_string()), value]);
                    } else {
                        list[idx].set_path(&path[1..], value)?;
                    }
                } else {
                    let mut new_node = SExpr::List(vec![SExpr::Atom(key.to_string())]);
                    if path.len() == 1 {
                        if let SExpr::List(ref mut v_list) = new_node {
                            v_list.push(value);
                        }
                    } else {
                        new_node.set_path(&path[1..], value)?;
                    }
                    list.push(new_node);
                }
                Ok(())
            }
            _ => Err("set_path is supported only on List nodes".to_string()),
        }
    }
}

// Locates the child SExpr for a key in a list starting at index 1.
pub fn find_sub_idx_in_list(list: &[SExpr], key: &str) -> Option<usize> {
    if list.is_empty() {
        return None;
    }
    for (idx, item) in list.iter().enumerate().skip(1) {
        if let SExpr::List(sub_list) = item {
            if let Some(SExpr::Atom(k)) = sub_list.first() {
                if k == key {
                    return Some(idx);
                }
            }
        }
    }
    None
}

// Production-grade structured parse error reporting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParserError {
    pub line: usize,
    pub column: usize,
    pub message: String,
    pub context: String,
}

impl std::fmt::Display for ParserError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "syntax error [line {}, column {}]: {} near '{}'",
            self.line, self.column, self.message, self.context
        )
    }
}

impl std::error::Error for ParserError {}

// Zero-copy streaming parser state machine.
struct Parser<'a> {
    input: &'a str,
    chars: std::str::CharIndices<'a>,
    current_char: Option<(usize, char)>,
    line: usize,
    column: usize,
}

impl<'a> Parser<'a> {
    fn new(input: &'a str) -> Self {
        let mut chars = input.char_indices();
        let current_char = chars.next();
        Self {
            input,
            chars,
            current_char,
            line: 1,
            column: 1,
        }
    }

    fn advance(&mut self) {
        if let Some((_, c)) = self.current_char {
            if c == '\n' {
                self.line += 1;
                self.column = 1;
            } else {
                self.column += 1;
            }
        }
        self.current_char = self.chars.next();
    }

    fn peek_char(&self) -> Option<char> {
        self.current_char.map(|(_, c)| c)
    }

    fn current_pos(&self) -> (usize, usize) {
        (self.line, self.column)
    }

    fn get_context(&self) -> String {
        let idx = self
            .current_char
            .map(|(i, _)| i)
            .unwrap_or(self.input.len());
        let start = self.input[..idx]
            .char_indices()
            .rev()
            .nth(14)
            .map_or(0, |(offset, _)| offset);
        let end = self.input[idx..]
            .char_indices()
            .nth(15)
            .map_or(self.input.len(), |(offset, _)| idx + offset);
        let snippet = &self.input[start..end];
        let mut context = String::new();
        if start > 0 {
            context.push_str("...");
        }
        context.push_str(snippet);
        if end < self.input.len() {
            context.push_str("...");
        }
        context
    }

    fn make_error(&self, message: String) -> ParserError {
        let (line, column) = self.current_pos();
        ParserError {
            line,
            column,
            message,
            context: self.get_context(),
        }
    }

    fn skip_whitespace(&mut self) {
        while let Some(c) = self.peek_char() {
            if c.is_whitespace() {
                self.advance();
            } else {
                break;
            }
        }
    }

    fn parse_value(&mut self, parent_depth: usize) -> Result<SExpr, ParserError> {
        self.skip_whitespace();
        let Some(mut c) = self.peek_char() else {
            return Err(self.make_error("Unexpected EOF".to_string()));
        };

        // Support conventional Lisp quote sugar: `'(...)` is a literal list and `'atom` a literal
        // Atom. Yao-lang lists are data by default and need no quote to suppress evaluation, so strip
        // the leading quote and continue. This prevents an LLM's unnecessary quote from producing
        // `[Atom("'"), List(...)]` and breaking the three-part `(set path value)` syntax.
        while c == '\'' {
            self.advance(); // consume '
            self.skip_whitespace();
            let Some(next) = self.peek_char() else {
                return Err(self.make_error("Unexpected EOF after quote".to_string()));
            };
            c = next;
        }

        if c == '(' {
            if parent_depth >= MAX_SEXPR_NESTING_DEPTH {
                return Err(self.make_error(format!(
                    "S-expression nesting exceeds the safe limit of {MAX_SEXPR_NESTING_DEPTH}"
                )));
            }
            self.advance(); // consume '('
            let mut list = Vec::new();
            loop {
                self.skip_whitespace();
                let Some(next_c) = self.peek_char() else {
                    // Automatic parenthesis balancing.
                    break;
                };
                if next_c == ')' {
                    self.advance(); // consume ')'
                    break;
                }
                let child = self.parse_value(parent_depth + 1)?;
                list.push(child);
            }
            Ok(SExpr::List(list))
        } else if c == '"' {
            self.advance(); // consume '"'
            let mut s = String::new();
            while let Some(next_c) = self.peek_char() {
                if next_c == '"' {
                    self.advance(); // consume '"'
                    return Ok(SExpr::Atom(s));
                }
                if next_c == '\\' {
                    self.advance(); // consume '\\'
                    if let Some(escaped_c) = self.peek_char() {
                        self.advance();
                        match escaped_c {
                            'n' => s.push('\n'),
                            't' => s.push('\t'),
                            'r' => s.push('\r'),
                            '\\' => s.push('\\'),
                            '"' => s.push('"'),
                            other => {
                                s.push('\\');
                                s.push(other);
                            }
                        }
                    } else {
                        s.push('\\');
                    }
                } else {
                    s.push(next_c);
                    self.advance();
                }
            }
            // Graceful fallback for an unterminated string.
            Ok(SExpr::Atom(s))
        } else {
            // Parse an ordinary Atom identifier.
            let mut s = String::new();
            while let Some(next_c) = self.peek_char() {
                if next_c.is_whitespace()
                    || next_c == '('
                    || next_c == ')'
                    || next_c == '"'
                    || next_c == '\''
                {
                    break;
                }
                s.push(next_c);
                self.advance();
            }
            if s.is_empty() {
                return Err(self.make_error("Empty atom".to_string()));
            }
            Ok(SExpr::Atom(s))
        }
    }
}

// Parses all top-level expressions. A Yao program, whether supplied to `eval` or loaded from a
// `.yao` file, may place declaration forms before its body and therefore contain multiple roots.
pub fn parse_all(input: &str) -> Result<Vec<SExpr>, ParserError> {
    let mut parser = Parser::new(input);
    let mut forms = Vec::new();
    loop {
        parser.skip_whitespace();
        if parser.peek_char().is_none() {
            break;
        }
        forms.push(parser.parse_value(0)?);
    }
    if forms.is_empty() {
        return Err(parser.make_error("input is empty or contains only whitespace".to_string()));
    }
    Ok(forms)
}

// S-Expression parser entry point with automatic parenthesis balancing.
pub fn parse(input: &str) -> Result<SExpr, ParserError> {
    let mut parser = Parser::new(input);
    parser.skip_whitespace();
    if parser.peek_char().is_none() {
        return Err(parser.make_error("input is empty or contains only whitespace".to_string()));
    }
    parser.parse_value(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normal_parse_and_format() {
        let input = "(context (kernel (session \"s1\") (version 1)) (mind (frame (id note) (body (text \"hello world\")))) (inbox))";
        let parsed = parse(input).unwrap();

        let formatted = parsed.to_string();
        assert_eq!(
            formatted,
            "(context (kernel (session s1) (version 1)) (mind (frame (id note) (body (text \"hello world\")))) (inbox))"
        );
    }

    #[test]
    fn test_auto_balancing_parentheses() {
        let input = "(context (meta (session \"s1\"";
        let parsed = parse(input).unwrap();

        let formatted = parsed.to_string();
        assert_eq!(formatted, "(context (meta (session s1)))");

        let input_multi = "(context-tx (base-version 0) (create note (text hello)";
        let parsed_multi = parse(input_multi).unwrap();
        assert_eq!(
            parsed_multi.to_string(),
            "(context-tx (base-version 0) (create note (text hello)))"
        );
    }

    #[test]
    fn test_unclosed_string_quote() {
        let input = "(session \"session_123";
        let parsed = parse(input).unwrap();
        assert_eq!(parsed.to_string(), "(session session_123)");
    }

    #[test]
    fn test_parser_position_errors() {
        let input = "   \n  \n   ";
        let err = parse(input).unwrap_err();
        assert_eq!(err.line, 3);
        assert_eq!(err.column, 4);
        assert!(err.message.contains("input is empty"));
    }

    #[test]
    fn test_quote_syntactic_sugar_list() {
        // Lisp-style `'(...)` should lose its quote and parse as an ordinary list.
        let input = "(create tasks '(items \"task1\" \"task2\"))";
        let parsed = parse(input).unwrap();
        // Expected: `(create, tasks, (items task1 task2))`, with length 3.
        if let SExpr::List(top) = &parsed {
            assert_eq!(top.len(), 3, "顶层 create 表达式应为 3 段");
            // The third part should be the quoted list, not a standalone `Atom("'")`.
            assert!(matches!(top[2], SExpr::List(_)));
        } else {
            panic!("解析结果应是 List");
        }
    }

    #[test]
    fn test_quote_syntactic_sugar_atom() {
        // `'atom` should parse as `Atom("atom")`.
        let input = "(create x 'hello)";
        let parsed = parse(input).unwrap();
        if let SExpr::List(top) = &parsed {
            assert_eq!(top.len(), 3);
            assert_eq!(top[2], SExpr::Atom("hello".to_string()));
        } else {
            panic!("解析结果应是 List");
        }
    }

    #[test]
    fn test_quote_inside_context_transaction() {
        // Reproduces a real LLM case: a quoted list inside `context-tx`.
        let input = r#"(context-tx
  (base-version 0)
  (create current (activity "读取项目"))
  (create completed '(items "任务A" "任务B"))
)"#;
        let parsed = parse(input).unwrap();
        if let SExpr::List(top) = &parsed {
            // Expect four parts: `context-tx`, `base-version`, and two `create` forms.
            assert_eq!(top.len(), 4);
            if let SExpr::List(create2) = &top[3] {
                assert_eq!(create2.len(), 3, "create 指令必须 3 段");
            } else {
                panic!("第二个 create 应为 List");
            }
        }
    }

    #[test]
    fn display_quotes_atoms_containing_single_quote_for_round_trip() {
        let original = SExpr::List(vec![
            SExpr::Atom("note".to_string()),
            SExpr::Atom("不可绝对化为'旧权威永远正确'。".to_string()),
        ]);
        let rendered = original.to_string();

        assert_eq!(rendered, "(note \"不可绝对化为'旧权威永远正确'。\")");
        assert_eq!(parse(&rendered).unwrap(), original);
    }

    #[test]
    fn parser_rejects_excessive_nesting_before_constructing_a_hostile_tree() {
        let accepted = format!(
            "{}value{}",
            "(".repeat(MAX_SEXPR_NESTING_DEPTH),
            ")".repeat(MAX_SEXPR_NESTING_DEPTH)
        );
        assert!(parse(&accepted).is_ok());

        let hostile = format!("{}value", "(".repeat(100_000));
        let error = parse(&hostile).unwrap_err();
        assert!(error.message.contains("nesting exceeds the safe limit"));
    }

    #[test]
    fn redundant_quote_prefix_is_iterative_and_does_not_consume_nesting_budget() {
        let input = format!("{}value", "'".repeat(100_000));
        assert_eq!(parse(&input).unwrap(), SExpr::Atom("value".to_string()));
    }

    #[test]
    fn parser_error_context_preserves_utf8_boundaries() {
        let error = parse_all("😀😀😀😀😀)").unwrap_err();
        assert_eq!(error.message, "Empty atom");
        assert!(error.context.contains("😀😀😀😀😀)"));
    }

    #[test]
    fn display_walks_manually_constructed_deep_trees_iteratively() {
        let mut value = SExpr::Atom("value".to_string());
        for _ in 0..4_096 {
            value = SExpr::List(vec![value]);
        }
        let rendered = value.to_string();
        assert_eq!(rendered.len(), 4_096 * 2 + "value".len());
        assert!(rendered.starts_with("(((("));
        assert!(rendered.ends_with("))))"));
        // `SExpr` is a public recursive enum, so a caller can manually build
        // a value deeper than the parser accepts. Avoid testing Rust's
        // recursive drop glue here; this assertion is specifically about the
        // formatter's own stack usage.
        std::mem::forget(value);
    }
}
