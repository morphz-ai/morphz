#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SExpr {
    Atom(String),
    List(Vec<SExpr>),
}

impl SExpr {
    // 格式化输出为 S-Expression 字符串
    pub fn to_string(&self) -> String {
        match self {
            SExpr::Atom(s) => {
                // 如果包含空格、括号、双引号、换行等，则使用双引号包裹并转义
                if s.contains(' ')
                    || s.contains('(')
                    || s.contains(')')
                    || s.contains('\n')
                    || s.contains('\r')
                    || s.contains('\t')
                    || s.contains('"')
                    || s.is_empty()
                {
                    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
                } else {
                    s.clone()
                }
            }
            SExpr::List(list) => {
                let items: Vec<String> = list.iter().map(|item| item.to_string()).collect();
                format!("({})", items.join(" "))
            }
        }
    }

    // 根据路径（例如 ["variables", "current_file"]）查找子节点的值
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

    // 根据路径（例如 ["variables", "current_file"]）可变借用查找子节点。
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

    // 根据路径设置或覆盖子节点，如果路径不存在则自动创建
    pub fn set_path(&mut self, path: &[&str], value: SExpr) -> Result<(), String> {
        if path.is_empty() {
            return Err("路径不能为空".to_string());
        }
        match self {
            SExpr::List(ref mut list) => {
                if list.is_empty() {
                    return Err("空 List 节点无法 set_path".to_string());
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
            _ => Err("只有 List 节点支持 set_path 演算".to_string()),
        }
    }
}

// 在列表（从 index 1 开始）中定位 key 所对应的子 SExpr 索引
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

// 工业级结构化解析异常报告
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
            "语法解析错误 [行 {}, 列 {}]: {} 附近上下文: '{}'",
            self.line, self.column, self.message, self.context
        )
    }
}

impl std::error::Error for ParserError {}

// 零拷贝流式解析状态机
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
        let idx = self.current_char.map(|(i, _)| i).unwrap_or(self.input.len());
        let start = idx.saturating_sub(15);
        let end = std::cmp::min(self.input.len(), idx + 15);
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

    fn parse_value(&mut self) -> Result<SExpr, ParserError> {
        self.skip_whitespace();
        let Some(c) = self.peek_char() else {
            return Err(self.make_error("Unexpected EOF".to_string()));
        };

        if c == '(' {
            self.advance(); // consume '('
            let mut list = Vec::new();
            loop {
                self.skip_whitespace();
                let Some(next_c) = self.peek_char() else {
                    // Auto-balancing 括号自动配平机制
                    break;
                };
                if next_c == ')' {
                    self.advance(); // consume ')'
                    break;
                }
                let child = self.parse_value()?;
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
            // 字符串未正常闭合做兜底
            Ok(SExpr::Atom(s))
        } else {
            // 解析普通的 Atom 标识符
            let mut s = String::new();
            while let Some(next_c) = self.peek_char() {
                if next_c.is_whitespace() || next_c == '(' || next_c == ')' || next_c == '"' {
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

// 自动括号配平的 S-Expression 解析器入口
pub fn parse(input: &str) -> Result<SExpr, ParserError> {
    let mut parser = Parser::new(input);
    parser.skip_whitespace();
    if parser.peek_char().is_none() {
        return Err(parser.make_error("输入为空或只包含空白字符".to_string()));
    }
    parser.parse_value()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normal_parse_and_format() {
        let input = "(context (metadata (session \"s1\")) (variables (a 1) (b \"hello world\")))";
        let parsed = parse(input).unwrap();
        
        let formatted = parsed.to_string();
        assert_eq!(
            formatted,
            "(context (metadata (session s1)) (variables (a 1) (b \"hello world\")))"
        );
    }

    #[test]
    fn test_auto_balancing_parentheses() {
        let input = "(context (metadata (session \"s1\"";
        let parsed = parse(input).unwrap();

        let formatted = parsed.to_string();
        assert_eq!(formatted, "(context (metadata (session s1)))");

        let input_multi = "(begin (set (variables a) 1";
        let parsed_multi = parse(input_multi).unwrap();
        assert_eq!(parsed_multi.to_string(), "(begin (set (variables a) 1))");
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
        assert!(err.message.contains("输入为空"));
    }
}
