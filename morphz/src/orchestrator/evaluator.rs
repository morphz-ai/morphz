use crate::sexpr::SExpr;

// 检查路径是否包含受限只读节点（如以 metadata 开头）
fn is_path_restricted(path: &[&str]) -> bool {
    if path.is_empty() {
        return false;
    }
    path[0] != "state"
}

// 解析指令中的路径表达式，如 (variables current_file) -> ["variables", "current_file"]
fn extract_path(path_expr: &SExpr) -> Result<Vec<&str>, String> {
    match path_expr {
        SExpr::List(list) => {
            let mut path = Vec::with_capacity(list.len());
            for item in list {
                if let SExpr::Atom(s) = item {
                    path.push(s.as_str());
                } else {
                    return Err("S-Expr 路径中的每一个元素都必须是 Atom 标识符".to_string());
                }
            }
            Ok(path)
        }
        SExpr::Atom(s) => {
            // 支持单路径，如 variables
            Ok(vec![s.as_str()])
        }
    }
}

// 演算虚拟机：对给定的指令进行状态求值修改
pub fn eval_instruction(context: &mut SExpr, instruction: &SExpr) -> Result<(), String> {
    match instruction {
        SExpr::List(list) => {
            if list.is_empty() {
                return Ok(());
            }
            let op_expr = &list[0];
            let op = match op_expr {
                SExpr::Atom(s) => s.as_str(),
                _ => return Err("指令操作符必须是 Atom 标识符".to_string()),
            };

            match op {
                "begin" => {
                    for sub_inst in &list[1..] {
                        eval_instruction(context, sub_inst)?;
                    }
                    Ok(())
                }
                "set" => {
                    if list.len() != 3 {
                        return Err("set 指令格式错误，应为 (set (path) value)".to_string());
                    }
                    let path_vec = extract_path(&list[1])?;
                    let val = &list[2];

                    if path_vec == vec!["context"] {
                        *context = val.clone();
                        return Ok(());
                    }

                    if is_path_restricted(&path_vec) {
                        return Err(format!("⚠️ [安全警报] 拒绝修改只读路径: {:?}", path_vec));
                    }

                    // 防御符号注入漏洞：
                    // 检查写入的 value。由于 S-Expr 具有 homoiconic 特征，
                    // 严禁将可执行指令（以 begin, set, push 等操作符开头的 List）作为变量值写入，防止发生指令二次评估执行。
                    if let SExpr::List(val_list) = val {
                        if let Some(SExpr::Atom(first_atom)) = val_list.first() {
                            let f = first_atom.as_str();
                            if f == "begin" || f == "set" || f == "push" || f == "pop" || f == "clear" {
                                return Err("⚠️ [安全警报] 检测到符号注入攻击：禁止将演算指令作为数据写入".to_string());
                            }
                        }
                    }

                    context.set_path(&path_vec, val.clone())?;
                    Ok(())
                }
                "push" => {
                    if list.len() != 3 {
                        return Err("push 指令格式错误，应为 (push (path) item)".to_string());
                    }
                    let path_vec = extract_path(&list[1])?;
                    let item = &list[2];

                    if is_path_restricted(&path_vec) {
                        return Err(format!("⚠️ [安全警报] 拒绝修改只读路径: {:?}", path_vec));
                    }

                    let target = match context.get_path_mut(&path_vec) {
                        Some(t) => t,
                        None => {
                            let last_segment = path_vec.last().ok_or("路径不能为空")?;
                            let init_val = SExpr::List(vec![SExpr::Atom(last_segment.to_string())]);
                            context.set_path(&path_vec, init_val)?;
                            context.get_path_mut(&path_vec).ok_or("自愈初始化失败")?
                        }
                    };

                    match target {
                        SExpr::List(ref mut t_list) => {
                            t_list.push(item.clone());
                            Ok(())
                        }
                        _ => Err("push 目标节点必须是 List 结构".to_string()),
                    }
                }
                "pop" => {
                    if list.len() != 2 {
                        return Err("pop 指令格式错误，应为 (pop (path))".to_string());
                    }
                    let path_vec = extract_path(&list[1])?;

                    if is_path_restricted(&path_vec) {
                        return Err(format!("⚠️ [安全警报] 拒绝修改只读路径: {:?}", path_vec));
                    }

                    let target = context.get_path_mut(&path_vec)
                        .ok_or_else(|| format!("未找到 pop 目标路径: {:?}", path_vec))?;

                    match target {
                        SExpr::List(ref mut t_list) => {
                            // 保证至少留下标识符元素本身
                            if t_list.len() > 1 {
                                t_list.pop();
                                Ok(())
                            } else {
                                Err("List 节点已空，无法 pop".to_string())
                            }
                        }
                        _ => Err("pop 目标节点必须是 List 结构".to_string()),
                    }
                }
                "clear" => {
                    if list.len() != 2 {
                        return Err("clear 指令格式错误，应为 (clear (path))".to_string());
                    }
                    let path_vec = extract_path(&list[1])?;

                    if path_vec == vec!["context"] {
                        if let SExpr::List(ref mut t_list) = context {
                            t_list.truncate(1);
                            return Ok(());
                        } else {
                            return Err("根节点不是 List 结构，无法 clear".to_string());
                        }
                    }

                    if is_path_restricted(&path_vec) {
                        return Err(format!("⚠️ [安全警报] 拒绝修改只读路径: {:?}", path_vec));
                    }

                    let target = context.get_path_mut(&path_vec)
                        .ok_or_else(|| format!("未找到 clear 目标路径: {:?}", path_vec))?;

                    match target {
                        SExpr::List(ref mut t_list) => {
                            // 阶段长度为 1，即只留下列表头的标识符本身
                            t_list.truncate(1);
                            Ok(())
                        }
                        _ => Err("clear 目标节点必须是 List 结构".to_string()),
                    }
                }
                _ => Err(format!("未识别的演算指令: {}", op)),
            }
        }
        _ => Err("演算指令必须是 List 结构".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sexpr::parse;

    #[test]
    fn test_eval_root_context_set_and_clear() {
        let context_str = "(context (meta (session \"s1\")) (state (registers (a 1))))";
        let mut context = parse(context_str).unwrap();

        // 测试对 root context 的 clear
        let clear_inst = parse("(clear (context))").unwrap();
        eval_instruction(&mut context, &clear_inst).unwrap();
        assert_eq!(context.to_string(), "(context)");

        // 测试对 root context 的 set
        let set_inst = parse("(set (context) (context (meta (session \"s2\"))))").unwrap();
        eval_instruction(&mut context, &set_inst).unwrap();
        assert_eq!(context.to_string(), "(context (meta (session s2)))");
    }

    #[test]
    fn test_eval_set_and_begin() {
        let context_str = "(context (meta (session \"s1\")) (state (registers (a 1))))";
        let mut context = parse(context_str).unwrap();

        let inst = parse("(begin (set (state registers a) 2) (set (state registers b) \"hello\"))").unwrap();
        eval_instruction(&mut context, &inst).unwrap();

        assert_eq!(
            context.to_string(),
            "(context (meta (session s1)) (state (registers (a 2) (b hello))))"
        );
    }

    #[test]
    fn test_eval_push_pop_clear() {
        let context_str = "(context (state (plan (todo_stack (task \"t1\")))))";
        let mut context = parse(context_str).unwrap();

        // 测试 push
        let push_inst = parse("(push (state plan todo_stack) (task \"t2\"))").unwrap();
        eval_instruction(&mut context, &push_inst).unwrap();
        assert_eq!(context.to_string(), "(context (state (plan (todo_stack (task t1) (task t2)))))");

        // 测试 pop
        let pop_inst = parse("(pop (state plan todo_stack))").unwrap();
        eval_instruction(&mut context, &pop_inst).unwrap();
        assert_eq!(context.to_string(), "(context (state (plan (todo_stack (task t1)))))");

        // 测试 clear
        let clear_inst = parse("(clear (state plan todo_stack))").unwrap();
        eval_instruction(&mut context, &clear_inst).unwrap();
        assert_eq!(context.to_string(), "(context (state (plan (todo_stack))))");
    }

    #[test]
    fn test_security_read_only_protection() {
        let context_str = "(context (meta (session \"s1\")))";
        let mut context = parse(context_str).unwrap();

        let attack_inst = parse("(set (meta session) \"s2\")").unwrap();
        let res = eval_instruction(&mut context, &attack_inst);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("安全警报"));
    }

    #[test]
    fn test_security_injection_protection() {
        let context_str = "(context (state (registers (a 1))))";
        let mut context = parse(context_str).unwrap();

        // 试图注入一个 begin 指令作为数据写入 registers 槽位
        let attack_inst = parse("(set (state registers a) (begin (set (meta session) \"s2\")))").unwrap();
        let res = eval_instruction(&mut context, &attack_inst);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("注入攻击"));
    }

    #[test]
    fn test_nested_chinese_path_eval() {
        let context_str = r#"(context (metadata (session sess_sub_tcp_01) (step 0)) (history (summary "") (turns)) (variables) (todo_stack) (graph_anchors) (state (plan (goal 列出知乎推荐内容) (todo_stack (todo "搜索 opencli 中知乎相关的命令"))) (registers (current_file "") (last_tool_status success))))"#;
        let mut context = parse(context_str).unwrap();
        let inst = parse(r#"(begin (set (state plan goal) "列出当前目录下所有文件和目录") (push (state plan todo_stack todo) (task "run_ls")))"#).unwrap();
        let res = eval_instruction(&mut context, &inst);
        assert!(res.is_ok());
    }
}
