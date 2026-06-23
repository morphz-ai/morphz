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
                // 如果包含空格、括号或双引号，或者为空，则使用双引号包裹并转义
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
    // 这对于 push, pop, clear 等原地演算指令非常重要。
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

// 自动括号配平的 S-Expression 解析器入口
pub fn parse(input: &str) -> Result<SExpr, String> {
    let chars: Vec<char> = input.chars().collect();
    let mut idx = 0;
    skip_whitespace(&chars, &mut idx);
    if idx >= chars.len() {
        return Err("输入为空或只包含空白字符".to_string());
    }
    parse_value(&chars, &mut idx)
}

fn skip_whitespace(chars: &[char], idx: &mut usize) {
    while *idx < chars.len() && (chars[*idx].is_whitespace()) {
        *idx += 1;
    }
}

fn parse_value(chars: &[char], idx: &mut usize) -> Result<SExpr, String> {
    skip_whitespace(chars, idx);
    if *idx >= chars.len() {
        return Err("Unexpected EOF".to_string());
    }

    if chars[*idx] == '(' {
        *idx += 1;
        let mut list = Vec::new();
        loop {
            skip_whitespace(chars, idx);
            if *idx >= chars.len() {
                // 【Auto-balancing 核心机制】
                // 遇到 EOF 且右括号不匹配时，自动 break 闭合当前列表
                // 这包容了大模型因为注意力或字数截断导致的括号缺失
                break;
            }
            if chars[*idx] == ')' {
                *idx += 1;
                break;
            }
            let child = parse_value(chars, idx)?;
            list.push(child);
        }
        Ok(SExpr::List(list))
    } else if chars[*idx] == '"' {
        *idx += 1;
        let mut s = String::new();
        while *idx < chars.len() {
            if chars[*idx] == '"' {
                *idx += 1;
                return Ok(SExpr::Atom(s));
            }
            if chars[*idx] == '\\' && *idx + 1 < chars.len() {
                *idx += 1;
                s.push(chars[*idx]);
            } else {
                s.push(chars[*idx]);
            }
            *idx += 1;
        }
        // 如果字符串未正常闭合，也做兜底闭合
        Ok(SExpr::Atom(s))
    } else {
        // 解析普通的 Atom 标识符
        let mut s = String::new();
        while *idx < chars.len() {
            let c = chars[*idx];
            if c.is_whitespace() || c == '(' || c == ')' || c == '"' {
                break;
            }
            s.push(c);
            *idx += 1;
        }
        if s.is_empty() {
            return Err("Empty atom".to_string());
        }
        Ok(SExpr::Atom(s))
    }
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
        // 模拟大模型在输出 S-Expression 时，漏掉了一到多层右括号的情形
        let input = "(context (metadata (session \"s1\"";
        let parsed = parse(input).unwrap();

        let formatted = parsed.to_string();
        // 应该自动被配平闭合为 (context (metadata (session s1))) 格式
        assert_eq!(formatted, "(context (metadata (session s1)))");

        let input_multi = "(begin (set (variables a) 1";
        let parsed_multi = parse(input_multi).unwrap();
        assert_eq!(parsed_multi.to_string(), "(begin (set (variables a) 1))");
    }

    #[test]
    fn test_unclosed_string_quote() {
        // 字符串未闭合兜底
        let input = "(session \"session_123";
        let parsed = parse(input).unwrap();
        assert_eq!(parsed.to_string(), "(session session_123)");
    }
}
