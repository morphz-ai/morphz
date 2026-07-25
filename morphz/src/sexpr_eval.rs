//! Deterministic evaluator for Agent-submitted S-expression programs.
//!
//! The same operator names the model is given in `sexpr_vm_contract` are
//! implemented here a second time, in code. A model that evaluates `seq` in its
//! head and a Runtime that evaluates `seq` over real tools are two
//! implementations of one semantics; this module is the deterministic one.
//!
//! The language is deliberately *total*: `seq`, `call`, `bind`, `if` and `map`
//! cannot express unbounded recursion, so every accepted program terminates.
//! That is what lets [`validate`] reject a program before a single side effect
//! runs. Adding a conditional loop would trade this for runtime fuel
//! accounting, which is why iteration here only ranges over a collection that
//! some earlier step already produced.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};

use crate::sexpr::SExpr;
use crate::tool::Registry;

/// Guards against a submitted program that is merely large rather than
/// recursive. Depth is checked before evaluation, so it costs nothing at run
/// time.
pub const MAX_PROGRAM_DEPTH: usize = 16;

/// Upper bound on one `map`. The collection size is only known once its
/// producing call returns, so termination is guaranteed by construction while
/// the *cost* still needs a ceiling.
pub const MAX_MAP_ELEMENTS: usize = 64;

/// Total `call` evaluations in one program, across every `map` expansion.
pub const MAX_PROGRAM_CALLS: usize = 128;

/// Total `infer` evaluations in one program. Each one is a model request, so
/// this bounds cost and latency rather than termination.
pub const MAX_PROGRAM_INFERS: usize = 8;

/// Model requests within a single `infer` while it gathers evidence.
///
/// An `infer` is a nested loop, so the real ceiling on a program is this times
/// [`MAX_PROGRAM_INFERS`]. Without it one question could spend a whole turn.
pub const MAX_INFER_ROUNDS: usize = 4;

/// One operator's self-description: name, surface form, and meaning.
///
/// Every surface that tells the model what it may write is generated from this
/// table, so the account it reads cannot drift from what the validator accepts.
/// A name alone leaves the model guessing at the form, which is exactly the
/// class of mistake the first evaluation produced.
pub struct OperatorSpec {
    pub name: &'static str,
    pub form: &'static str,
    pub description: &'static str,
    /// Where this operator can be evaluated. One language, two evaluators:
    /// an operator missing on one side is annotated, never redefined.
    pub available: Availability,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Availability {
    /// Both the LLM's own evaluation and a submitted program.
    Both,
    /// Only inside a program submitted for deterministic evaluation.
    RuntimeEval,
    /// Only in the LLM's own evaluation; the deterministic evaluator refuses it.
    LlmOnly,
}

/// The single operator table. Shared operators carry exactly the form the
/// production contract (`sexpr_vm_contract`) teaches; a consistency test locks
/// the two together so this table cannot drift into a second dialect.
pub const OPERATORS: [OperatorSpec; 9] = [
    OperatorSpec {
        name: "seq",
        form: "(seq step...)",
        description: "从左到右求值每个 step，返回最后一个 step 的值。要让程序产出某个绑定，把 $名字 放在最后一个 step。",
        available: Availability::Both,
    },
    OperatorSpec {
        name: "bind",
        form: "(bind name expression)",
        description: "先完整求值 expression，再绑定到 name。name 不带 $，引用时才写 $name；取字段写 $name.field。绑定不可覆盖。",
        available: Availability::Both,
    },
    OperatorSpec {
        name: "call",
        form: "(call tool argument...)",
        description: "调用 tool。argument 是标准 JSON 工具参数；在程序文本中以 (参数名 值...) 列表书写，例如 (call read (path \"src/a.rs\"))。一个参数给多个值即数组；值只能是字面量或 $引用。Runtime 按工具 schema 换算类型。",
        available: Availability::Both,
    },
    OperatorSpec {
        name: "if",
        form: "(if condition when-true when-false)",
        description: "condition 只能是字面量或 $引用。只求值被选中的一支，未选分支不产生任何工具调用；分支内的绑定不流出该分支。",
        available: Availability::Both,
    },
    OperatorSpec {
        name: "map",
        form: "(map $collection element body)",
        description: "对 $collection 逐个元素求值 body，返回结果数组。$collection 必须已绑定且是数组；element 是元素名，不带 $，在 body 中用 $element 引用。",
        available: Availability::RuntimeEval,
    },
    OperatorSpec {
        name: "infer",
        form: "(infer (task \"要判断什么\") argument...)",
        description: "把判断交回非确定性求值器（你自己）：(task ...) 必填，其余 (参数名 值) 是给它看的证据。它可先调用工具取证，返回值是数据（文本），绑定后继续求值。",
        available: Availability::RuntimeEval,
    },
    OperatorSpec {
        name: "reply",
        form: "(reply content)",
        description: "交付用户可见回复。只存在于你自己的求值中；提交给 Runtime 的程序产出值，不产出回复。",
        available: Availability::LlmOnly,
    },
    OperatorSpec {
        name: "fallback",
        form: "(fallback primary backup)",
        description: "先求值 primary；只有 primary 返回已分类失败时才求值 backup。primary 成功时 backup 不产生任何调用；任一分支内的绑定不流出该分支。",
        available: Availability::Both,
    },
    OperatorSpec {
        name: "process",
        form: "(process ...)",
        description: "定义命名过程。只存在于你自己的求值中。",
        available: Availability::LlmOnly,
    },
];

/// Names by availability, derived from the one table.
fn names_with(available: Availability) -> Vec<&'static str> {
    OPERATORS
        .iter()
        .filter(|spec| spec.available == available)
        .map(|spec| spec.name)
        .collect()
}

/// Names the deterministic evaluator accepts, for error messages.
pub fn evaluable_names() -> Vec<&'static str> {
    OPERATORS
        .iter()
        .filter(|spec| spec.available != Availability::LlmOnly)
        .map(|spec| spec.name)
        .collect()
}

/// Renders the operator table as the S-expression the model reads, matching
/// how `sexpr_vm_contract` presents the operators it already knows.
pub fn operator_contract() -> String {
    let mut lines = Vec::new();
    for spec in &OPERATORS {
        if spec.available == Availability::LlmOnly {
            continue;
        }
        lines.push(format!(
            "    (operator {name}\n      (form {form})\n      (description {description:?}))",
            name = spec.name,
            form = spec.form,
            description = spec.description,
        ));
    }
    format!("  (operators\n{})", lines.join("\n"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvalError {
    pub message: String,
}

impl std::fmt::Display for EvalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for EvalError {}

impl From<String> for EvalError {
    fn from(message: String) -> Self {
        Self { message }
    }
}

fn err<T>(message: impl Into<String>) -> Result<T, EvalError> {
    Err(EvalError {
        message: message.into(),
    })
}

/// Which evaluator owns the outer program loop.
///
/// This is part of the source semantics rather than a loader guess.  A
/// Runtime-owned program lowers to a resumable plan; a model-owned program
/// enters the ordinary Evaluation/attempt loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationOwner {
    Runtime,
    Model,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProgramHeader {
    pub owner: EvaluationOwner,
    pub declared_tools: Option<Vec<String>>,
}

/// A value embedded in a plan node.
///
/// Separating literals from references during lowering means the executor
/// never has to reinterpret `$name.field` syntax after a restart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum PlanValue {
    Literal(String),
    Reference(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanArgument {
    pub name: String,
    pub values: Vec<PlanValue>,
}

/// Runtime's typed, serializable representation of one Yao program.
///
/// It deliberately contains no tool implementation or Future.  A later
/// Scheduler integration can persist this tree together with a program
/// counter, bindings and pending child work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum PlanNode {
    Value {
        value: PlanValue,
    },
    Seq {
        steps: Vec<PlanNode>,
    },
    Bind {
        name: String,
        value: Box<PlanNode>,
    },
    If {
        condition: PlanValue,
        when_true: Box<PlanNode>,
        when_false: Box<PlanNode>,
    },
    Fallback {
        primary: Box<PlanNode>,
        backup: Box<PlanNode>,
    },
    Map {
        collection: PlanValue,
        element: String,
        body: Box<PlanNode>,
    },
    Infer {
        arguments: Vec<PlanArgument>,
    },
    Call {
        tool: String,
        arguments: Vec<PlanArgument>,
    },
}

/// A validated program. Holding this type is the evidence that [`validate`]
/// accepted and lowered the source, so execution never sees unchecked syntax.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Program {
    owner: EvaluationOwner,
    root: PlanNode,
    /// Tools the program will reach, in first-appearance order.
    ///
    /// Callers settle capability and approval from this before the Job starts,
    /// and derive retry safety by taking the strictest `retry_safety` among
    /// them. Note what is deliberately absent: `infer` contributes nothing to
    /// that decision. It is non-deterministic but still safe to replay, because
    /// replaying accumulates no external effect — each run simply judges the
    /// environment as it stands, which is the whole point of the step.
    /// Demanding identical output from a non-deterministic evaluator would be
    /// the wrong test; the right one is whether a second run can corrupt
    /// anything, and here it cannot.
    tools: Vec<String>,
    /// Tools declared by `(requires (tools NAME...))` inside the explicit
    /// `eval`/`infer` root.
    ///
    /// Declaration exists for the part static analysis cannot see: which
    /// tools an `infer` may gather evidence with is decided at run time, so
    /// only the program itself can bound it. It lives in the program text —
    /// not in a side channel — because a `.yao` file loaded by the Runtime
    /// has no other way to state its needs; the model's `program` argument
    /// and a `.yao` file are the same artifact. `None` means no declaration
    /// and the deployment gate applies unchanged.
    declared: Option<Vec<String>>,
}

impl Program {
    pub fn owner(&self) -> EvaluationOwner {
        self.owner
    }

    pub fn root(&self) -> &PlanNode {
        &self.root
    }

    pub fn tools(&self) -> &[String] {
        &self.tools
    }

    pub fn declared_tools(&self) -> Option<&[String]> {
        self.declared.as_deref()
    }
}

/// What a `call` node may reach. Callers narrow this; the evaluator never
/// widens it.
pub trait ToolGate: Send + Sync {
    fn is_callable(&self, tool: &str) -> bool;
    fn describe_refusal(&self, tool: &str) -> String;
}

/// Names a tool must match to appear inside a program.
pub struct AllowList {
    allowed: HashSet<String>,
}

impl AllowList {
    pub fn new(names: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            allowed: names.into_iter().map(Into::into).collect(),
        }
    }
}

impl ToolGate for AllowList {
    fn is_callable(&self, tool: &str) -> bool {
        self.allowed.contains(tool)
    }

    fn describe_refusal(&self, tool: &str) -> String {
        let mut names = self.allowed.iter().cloned().collect::<Vec<_>>();
        names.sort();
        format!(
            "工具 '{tool}' 不能在 eval 程序中调用；此处只接受 {}。其他工具请使用普通 Function Calling。",
            names.join("、")
        )
    }
}

/// Validates a program against the operator table, the tool registry and the
/// gate, without evaluating anything.
///
/// Everything checkable before execution is checked here, because a rejection
/// that arrives after three files were already read is not a rejection.
pub fn validate(
    source: &str,
    registry: &Registry,
    gate: &dyn ToolGate,
) -> Result<Program, EvalError> {
    let forms = crate::sexpr::parse_all(source).map_err(|error| EvalError {
        message: format!("program 不是合法的 S 表达式: {error}"),
    })?;
    let (owner, declared, root) = split_program(forms)?;
    if let Some(declared) = &declared {
        // The declaration must sit inside the deployment gate: a program
        // cannot widen its own admission by asking.
        for tool in declared {
            if !gate.is_callable(tool) {
                return Err(EvalError::from(gate.describe_refusal(tool)));
            }
            if registry.get(tool).is_none() {
                return err(format!("声明的工具 '{tool}' 不存在"));
            }
        }
    }
    // Inside the body the declaration *becomes* the gate, so an undeclared
    // call is refused even where the deployment would have allowed it.
    let narrowed = declared.as_ref().map(|tools| AllowList::new(tools.clone()));
    let effective_gate: &dyn ToolGate = match &narrowed {
        Some(list) => list,
        None => gate,
    };
    let mut scope = Scope::default();
    let mut facts = ProgramFacts::default();
    check(&root, 0, &mut scope, registry, effective_gate, &mut facts)?;
    let root = lower_expr(&root)?;
    Ok(Program {
        owner,
        root,
        tools: facts.tools,
        declared,
    })
}

/// Parses only the stable program envelope.
///
/// Harness loading can use this without a live tool registry. Full operator,
/// schema and deployment-gate validation still happens before activation.
pub fn inspect_program_source(source: &str) -> Result<ProgramHeader, EvalError> {
    let forms = crate::sexpr::parse_all(source).map_err(|error| EvalError {
        message: format!("program 不是合法的 S 表达式: {error}"),
    })?;
    let (owner, declared_tools, _) = split_program(forms)?;
    Ok(ProgramHeader {
        owner,
        declared_tools,
    })
}

/// Reads the explicit evaluator root and its optional capability narrowing.
///
/// The outer `(eval ...)` / `(infer ...)` is intentionally mandatory.  The
/// same inner tree can otherwise change owner merely by being wrapped in
/// `seq`, which makes persistence and failure semantics impossible to inspect.
fn split_program(
    forms: Vec<SExpr>,
) -> Result<(EvaluationOwner, Option<Vec<String>>, SExpr), EvalError> {
    let [form] = forms.as_slice() else {
        return err("Yao 程序必须恰好有一个显式根：(eval ...) 或 (infer ...)".to_string());
    };
    let SExpr::List(items) = form else {
        return err("Yao 程序根必须是 (eval ...) 或 (infer ...)".to_string());
    };
    let Some(SExpr::Atom(root_name)) = items.first() else {
        return err("Yao 程序根缺少求值器名称".to_string());
    };
    let owner = match root_name.as_str() {
        "eval" => EvaluationOwner::Runtime,
        "infer" => EvaluationOwner::Model,
        other => {
            return err(format!(
                "未知的 Yao 程序根 '{other}'；必须显式使用 (eval ...) 或 (infer ...)"
            ))
        }
    };

    let mut body = items[1..].to_vec();
    let declared = match body.first() {
        Some(SExpr::List(requires))
            if requires.first() == Some(&SExpr::Atom("requires".to_string())) =>
        {
            let declared = parse_requires(requires)?;
            body.remove(0);
            Some(declared)
        }
        _ => None,
    };

    let root = match owner {
        EvaluationOwner::Runtime => {
            let [root] = body.as_slice() else {
                return err(
                    "(eval ...) 在可选的 (requires ...) 后必须恰好包含一个程序体；多个步骤用 (seq ...) 组合"
                        .to_string(),
                );
            };
            root.clone()
        }
        EvaluationOwner::Model => {
            if body.is_empty() {
                return err("(infer ...) 至少需要一个 (task ...) 参数".to_string());
            }
            let mut infer = Vec::with_capacity(body.len() + 1);
            infer.push(SExpr::Atom("infer".to_string()));
            infer.extend(body);
            SExpr::List(infer)
        }
    };
    Ok((owner, declared, root))
}

fn parse_requires(items: &[SExpr]) -> Result<Vec<String>, EvalError> {
    let mut declared = None;
    for clause in &items[1..] {
        let SExpr::List(parts) = clause else {
            return err("(requires ...) 的每一项必须是列表".to_string());
        };
        let Some(SExpr::Atom(name)) = parts.first() else {
            return err("(requires ...) 子项缺少名称".to_string());
        };
        match name.as_str() {
            "tools" => {
                if declared.is_some() {
                    return err("(requires ...) 只能声明一次 (tools ...)".to_string());
                }
                let mut tools = Vec::new();
                for item in &parts[1..] {
                    let SExpr::Atom(tool) = item else {
                        return err("(requires (tools ...)) 里只能是工具名原子".to_string());
                    };
                    if !tools.contains(tool) {
                        tools.push(tool.clone());
                    }
                }
                declared = Some(tools);
            }
            other => {
                return err(format!(
                    "当前版本不认识 requires 子项 '({other} ...)'; 可用的是 (tools ...)"
                ))
            }
        }
    }
    Ok(declared.unwrap_or_default())
}

/// What the walk learns about a program, for the caller to settle capability
/// before evaluation starts.
#[derive(Default)]
struct ProgramFacts {
    tools: Vec<String>,
}

#[derive(Default)]
struct Scope {
    bound: Vec<String>,
}

impl Scope {
    fn contains(&self, name: &str) -> bool {
        self.bound.iter().any(|item| item == name)
    }
}

fn operator_of(expr: &SExpr) -> Result<(&str, &[SExpr]), EvalError> {
    let SExpr::List(items) = expr else {
        return err(format!(
            "期望一个 (算子 ...) 形式的表达式，得到原子 '{expr}'"
        ));
    };
    let Some(SExpr::Atom(name)) = items.first() else {
        return err("表达式的第一项必须是算子名".to_string());
    };
    Ok((name.as_str(), &items[1..]))
}

fn check(
    expr: &SExpr,
    depth: usize,
    scope: &mut Scope,
    registry: &Registry,
    gate: &dyn ToolGate,
    facts: &mut ProgramFacts,
) -> Result<(), EvalError> {
    if depth > MAX_PROGRAM_DEPTH {
        return err(format!(
            "程序嵌套超过 {MAX_PROGRAM_DEPTH} 层；请拆成多次 eval"
        ));
    }
    // An atom in expression position is self-evaluating. Without this a
    // program could bind a value but never yield one: `seq` returns its last
    // step, and every operator that can end a program returns something other
    // than the binding the program was written to produce.
    if matches!(expr, SExpr::Atom(_)) {
        return check_value(expr, scope);
    }
    let (operator, args) = operator_of(expr)?;
    if names_with(Availability::LlmOnly).contains(&operator) {
        return err(format!(
            "算子 '{operator}' 只用于你自身的求值，提交给 Runtime 的程序中不可用；此处可用的算子是 {}。",
            evaluable_names().join("、")
        ));
    }
    match operator {
        "seq" => {
            if args.is_empty() {
                return err("(seq ...) 至少需要一个步骤".to_string());
            }
            for step in args {
                check(step, depth + 1, scope, registry, gate, facts)?;
            }
            Ok(())
        }
        "bind" => {
            let [SExpr::Atom(name), value] = args else {
                return err("(bind NAME EXPR) 需要一个名字和一个表达式".to_string());
            };
            if name.starts_with('$') {
                return err(format!(
                    "(bind {name} ...) 的名字不带 $；引用它时才写 ${}",
                    name.trim_start_matches('$')
                ));
            }
            check(value, depth + 1, scope, registry, gate, facts)?;
            if scope.contains(name) {
                // Single assignment keeps the data dependencies of a program
                // readable straight off the tree.
                return err(format!("绑定 '{name}' 不可覆盖；请换一个名字"));
            }
            scope.bound.push(name.clone());
            Ok(())
        }
        "if" => {
            let [condition, when_true, when_false] = args else {
                return err("(if COND THEN ELSE) 需要三段".to_string());
            };
            check_value(condition, scope)?;
            // Branches are checked in a copy of the scope: a binding made in a
            // branch that is not taken must not be visible afterwards.
            for branch in [when_true, when_false] {
                let mut branch_scope = Scope {
                    bound: scope.bound.clone(),
                };
                check(branch, depth + 1, &mut branch_scope, registry, gate, facts)?;
            }
            Ok(())
        }
        "fallback" => {
            let [primary, backup] = args else {
                return err("(fallback PRIMARY BACKUP) 需要两段".to_string());
            };
            for branch in [primary, backup] {
                let mut branch_scope = Scope {
                    bound: scope.bound.clone(),
                };
                check(branch, depth + 1, &mut branch_scope, registry, gate, facts)?;
            }
            Ok(())
        }
        "map" => {
            let [collection, SExpr::Atom(element), body] = args else {
                return err("(map $COLLECTION ELEMENT BODY) 需要三段".to_string());
            };
            check_value(collection, scope)?;
            if element.starts_with('$') {
                return err(format!(
                    "(map ... {element} ...) 的元素名不带 $；在 BODY 中引用它时才写 ${}",
                    element.trim_start_matches('$')
                ));
            }
            let mut body_scope = Scope {
                bound: scope.bound.clone(),
            };
            body_scope.bound.push(element.clone());
            check(body, depth + 1, &mut body_scope, registry, gate, facts)?;
            Ok(())
        }
        "infer" => {
            // `infer` returns data, never a program. Letting it return
            // something evaluable would close the loop
            // `infer -> eval -> infer` and make the language Turing complete,
            // at which point `validate` can no longer bound a program before
            // running it. That is the property this evaluator is built on.
            if args.is_empty() {
                return err("(infer (task \"...\") ...) 至少需要一个 (task ...) 参数".to_string());
            }
            check_pair_arguments("infer", args, scope)?;
            let has_task = args.iter().any(|argument| {
                matches!(argument, SExpr::List(items)
                    if items.first() == Some(&SExpr::Atom("task".to_string())))
            });
            if !has_task {
                return err("(infer ...) 必须给出 (task ...) 说明要判断什么".to_string());
            }
            Ok(())
        }
        "call" => {
            let Some(SExpr::Atom(tool)) = args.first() else {
                return err("(call tool argument...) 缺少工具名".to_string());
            };
            if !gate.is_callable(tool) {
                return err(gate.describe_refusal(tool));
            }
            if registry.get(tool).is_none() {
                return err(format!("工具 '{tool}' 不存在"));
            }
            check_call_arguments(tool, &args[1..], scope)?;
            if !facts.tools.iter().any(|seen| seen == tool) {
                facts.tools.push(tool.clone());
            }
            Ok(())
        }
        other => err(format!(
            "未知算子 '{other}'；eval 程序中可用的算子是 {}。",
            evaluable_names().join("、")
        )),
    }
}

fn check_call_arguments(tool: &str, args: &[SExpr], scope: &Scope) -> Result<(), EvalError> {
    check_pair_arguments(&format!("call {tool}"), args, scope)
}

/// Arguments are the language's own idiom for named data: `(name value...)`
/// lists, exactly as Kernel, Mind and the protocol render everything else.
/// Multiple values under one name form an array.
fn check_pair_arguments(form: &str, args: &[SExpr], scope: &Scope) -> Result<(), EvalError> {
    let mut seen = HashSet::new();
    for argument in args {
        let SExpr::List(items) = argument else {
            return err(format!(
                "({form} ...) 的每个参数必须是 (参数名 值...) 列表，得到 '{argument}'"
            ));
        };
        let Some(SExpr::Atom(name)) = items.first() else {
            return err(format!("({form} ...) 的参数列表第一项必须是参数名"));
        };
        if items.len() < 2 {
            return err(format!("({form} ... ({name})) 缺少值"));
        }
        if !seen.insert(name.clone()) {
            return err(format!("({form} ...) 重复指定了参数 '({name} ...)'"));
        }
        for value in &items[1..] {
            check_value(value, scope)?;
        }
    }
    Ok(())
}

/// A value position accepts a literal or a `$name` reference to something an
/// earlier `bind` produced.
fn check_value(expr: &SExpr, scope: &Scope) -> Result<(), EvalError> {
    match expr {
        SExpr::Atom(atom) => {
            let Some(reference) = atom.strip_prefix('$') else {
                return Ok(());
            };
            let name = reference.split('.').next().unwrap_or_default();
            if name.is_empty() {
                return err("'$' 后面缺少绑定名".to_string());
            }
            if !scope.contains(name) {
                return err(format!(
                    "引用了未绑定的 '${name}'；请先用 (bind {name} ...) 绑定它"
                ));
            }
            Ok(())
        }
        SExpr::List(_) => err(format!(
            "值的位置只接受字面量或 $绑定引用，不接受子表达式 '{expr}'"
        )),
    }
}

fn lower_value(expr: &SExpr) -> Result<PlanValue, EvalError> {
    let SExpr::Atom(atom) = expr else {
        return err(format!("值的位置不接受子表达式 '{expr}'"));
    };
    Ok(match atom.strip_prefix('$') {
        Some(reference) => PlanValue::Reference(reference.to_string()),
        None => PlanValue::Literal(atom.clone()),
    })
}

fn lower_arguments(args: &[SExpr]) -> Result<Vec<PlanArgument>, EvalError> {
    args.iter()
        .map(|argument| {
            let SExpr::List(items) = argument else {
                return err(format!("参数必须是 (参数名 值...) 列表，得到 '{argument}'"));
            };
            let Some(SExpr::Atom(name)) = items.first() else {
                return err("参数列表第一项必须是参数名".to_string());
            };
            let values = items[1..]
                .iter()
                .map(lower_value)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(PlanArgument {
                name: name.clone(),
                values,
            })
        })
        .collect()
}

fn lower_expr(expr: &SExpr) -> Result<PlanNode, EvalError> {
    if matches!(expr, SExpr::Atom(_)) {
        return Ok(PlanNode::Value {
            value: lower_value(expr)?,
        });
    }
    let (operator, args) = operator_of(expr)?;
    match operator {
        "seq" => Ok(PlanNode::Seq {
            steps: args.iter().map(lower_expr).collect::<Result<Vec<_>, _>>()?,
        }),
        "bind" => {
            let [SExpr::Atom(name), value] = args else {
                return err("(bind NAME EXPR) 形态错误".to_string());
            };
            Ok(PlanNode::Bind {
                name: name.clone(),
                value: Box::new(lower_expr(value)?),
            })
        }
        "if" => {
            let [condition, when_true, when_false] = args else {
                return err("(if COND THEN ELSE) 形态错误".to_string());
            };
            Ok(PlanNode::If {
                condition: lower_value(condition)?,
                when_true: Box::new(lower_expr(when_true)?),
                when_false: Box::new(lower_expr(when_false)?),
            })
        }
        "fallback" => {
            let [primary, backup] = args else {
                return err("(fallback PRIMARY BACKUP) 形态错误".to_string());
            };
            Ok(PlanNode::Fallback {
                primary: Box::new(lower_expr(primary)?),
                backup: Box::new(lower_expr(backup)?),
            })
        }
        "map" => {
            let [collection, SExpr::Atom(element), body] = args else {
                return err("(map COLLECTION ELEMENT BODY) 形态错误".to_string());
            };
            Ok(PlanNode::Map {
                collection: lower_value(collection)?,
                element: element.clone(),
                body: Box::new(lower_expr(body)?),
            })
        }
        "infer" => Ok(PlanNode::Infer {
            arguments: lower_arguments(args)?,
        }),
        "call" => {
            let Some(SExpr::Atom(tool)) = args.first() else {
                return err("(call TOOL ...) 形态错误".to_string());
            };
            Ok(PlanNode::Call {
                tool: tool.clone(),
                arguments: lower_arguments(&args[1..])?,
            })
        }
        other => err(format!("未知算子 '{other}'")),
    }
}

/// The boundary back into the non-deterministic evaluator.
///
/// This is a seam, not a second model client: the implementation belongs to the
/// Orchestrator and must reach the model through the very path an ordinary turn
/// uses, so `infer` inherits provider admission, queueing and deadlines rather
/// than quietly acquiring its own. The trait exists only because this module
/// cannot depend on the Orchestrator that depends on it.
///
/// The arguments an `infer` node declares are its whole input. What they become
/// in a request is the Orchestrator's business; the evaluator does not assemble
/// prompts.
#[async_trait::async_trait]
pub trait RuntimeInference: Send + Sync {
    /// `tools` is the program's declaration, when it made one: the host must
    /// offer no more than this while the model gathers evidence. `None` means
    /// the deployment default applies.
    async fn infer(
        &self,
        request: &JsonMap<String, JsonValue>,
        tools: Option<&[String]>,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>>;
}

/// Runtime-owned effect emitted by the deterministic plan machine.
///
/// The machine never performs this work itself.  The Scheduler derives the
/// durable child identity from `(plan_execution_id, sequence)`, materializes
/// an Execution Job / Action Group / Evaluation, and only then records the
/// plan as waiting.  Replaying a suspended machine therefore yields the same
/// effect rather than executing it twice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlanEffect {
    Call {
        sequence: u64,
        tool: String,
        arguments: JsonMap<String, JsonValue>,
    },
    Infer {
        sequence: u64,
        request: JsonMap<String, JsonValue>,
        tools: Option<Vec<String>>,
    },
}

impl PlanEffect {
    pub fn sequence(&self) -> u64 {
        match self {
            Self::Call { sequence, .. } | Self::Infer { sequence, .. } => *sequence,
        }
    }

    fn failure(&self, message: impl std::fmt::Display) -> String {
        match self {
            Self::Call { tool, .. } => format!("(call {tool} ...) 失败: {message}"),
            Self::Infer { .. } => format!("(infer ...) 失败: {message}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanAdvance {
    Suspended(PlanEffect),
    Complete(JsonValue),
    Failed(EvalError),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct PlanBudget {
    calls_left: usize,
    infers_left: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum MachineSignal {
    Value { value: JsonValue },
    Failure { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum MachineTerminal {
    Complete { value: JsonValue },
    Failed { message: String },
}

/// Serializable continuation frames.  No frame contains a Future, tool
/// implementation, model client or database connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum MachineFrame {
    Eval {
        node: PlanNode,
    },
    Seq {
        steps: Vec<PlanNode>,
        next: usize,
    },
    Bind {
        name: String,
    },
    RestoreScope {
        saved_env: HashMap<String, JsonValue>,
    },
    FallbackPrimary {
        backup: PlanNode,
        saved_env: HashMap<String, JsonValue>,
    },
    MapItem {
        items: Vec<JsonValue>,
        next: usize,
        element: String,
        body: PlanNode,
        results: Vec<JsonValue>,
        saved_env: HashMap<String, JsonValue>,
    },
}

/// Durable deterministic state of one Runtime-owned Yao program.
///
/// `PlanMachine` is the `state_json` stored by `PlanExecution`.  Calling
/// [`PlanMachine::advance`] is pure control work until it returns
/// [`PlanAdvance::Suspended`].  The pending effect remains embedded in the
/// state until a causally matching result is supplied, which is what makes
/// process restart and lease takeover safe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanMachine {
    frames: Vec<MachineFrame>,
    env: HashMap<String, JsonValue>,
    signal: Option<MachineSignal>,
    pending: Option<PlanEffect>,
    terminal: Option<MachineTerminal>,
    declared_tools: Option<Vec<String>>,
    budget: PlanBudget,
    next_effect_sequence: u64,
}

impl PlanMachine {
    pub fn new(program: &Program) -> Result<Self, EvalError> {
        if program.owner != EvaluationOwner::Runtime {
            return err(
                "(infer ...) 是模型持有控制权的程序，必须创建正式 Evaluation，不能交给 Runtime Plan Executor"
                    .to_string(),
            );
        }
        Ok(Self {
            frames: vec![MachineFrame::Eval {
                node: program.root.clone(),
            }],
            env: HashMap::new(),
            signal: None,
            pending: None,
            terminal: None,
            declared_tools: program.declared.clone(),
            budget: PlanBudget {
                calls_left: MAX_PROGRAM_CALLS,
                infers_left: MAX_PROGRAM_INFERS,
            },
            next_effect_sequence: 1,
        })
    }

    pub fn pending_effect(&self) -> Option<&PlanEffect> {
        self.pending.as_ref()
    }

    /// Durable budget projection stored beside the complete machine state.
    ///
    /// `state_json` remains self-contained; this smaller projection exists so
    /// schedulers and diagnostics can inspect remaining cost without decoding
    /// the private continuation-frame schema.
    pub fn budget_json(&self) -> Result<JsonValue, EvalError> {
        serde_json::to_value(&self.budget)
            .map_err(|error| EvalError::from(format!("Plan budget 序列化失败: {error}")))
    }

    /// Continues deterministic evaluation until completion, failure or the
    /// next Kernel-owned effect boundary.
    pub fn advance(&mut self, registry: &Registry) -> PlanAdvance {
        if let Some(terminal) = &self.terminal {
            return terminal.clone().into();
        }
        if let Some(effect) = &self.pending {
            return PlanAdvance::Suspended(effect.clone());
        }

        loop {
            if self.frames.is_empty() {
                let terminal = match self.signal.take() {
                    Some(MachineSignal::Value { value }) => MachineTerminal::Complete { value },
                    Some(MachineSignal::Failure { message }) => MachineTerminal::Failed { message },
                    None => MachineTerminal::Failed {
                        message: "Plan Machine 没有待执行 frame，也没有结果".to_string(),
                    },
                };
                self.terminal = Some(terminal.clone());
                return terminal.into();
            }

            let frame = self.frames.pop().expect("checked above");
            match frame {
                MachineFrame::Eval { node } => {
                    if self.signal.is_some() {
                        return self.fail_internal("Plan Machine 在已有结果时仍尝试求值新节点");
                    }
                    match node {
                        PlanNode::Value { value } => match resolve_value(&value, &self.env) {
                            Ok(value) => self.signal = Some(MachineSignal::Value { value }),
                            Err(error) => self.raise(error),
                        },
                        PlanNode::Seq { steps } => {
                            let Some(first) = steps.first().cloned() else {
                                self.raise(EvalError::from(
                                    "Plan IR 中的 seq 不应为空；validator 未守住边界".to_string(),
                                ));
                                continue;
                            };
                            self.frames.push(MachineFrame::Seq {
                                steps,
                                next: 1,
                            });
                            self.frames.push(MachineFrame::Eval { node: first });
                        }
                        PlanNode::Bind { name, value } => {
                            self.frames.push(MachineFrame::Bind { name });
                            self.frames.push(MachineFrame::Eval { node: *value });
                        }
                        PlanNode::If {
                            condition,
                            when_true,
                            when_false,
                        } => match resolve_value(&condition, &self.env) {
                            Ok(condition) => {
                                let selected = if truthy(&condition) {
                                    *when_true
                                } else {
                                    *when_false
                                };
                                self.frames.push(MachineFrame::RestoreScope {
                                    saved_env: self.env.clone(),
                                });
                                self.frames.push(MachineFrame::Eval { node: selected });
                            }
                            Err(error) => self.raise(error),
                        },
                        PlanNode::Fallback { primary, backup } => {
                            self.frames.push(MachineFrame::FallbackPrimary {
                                backup: *backup,
                                saved_env: self.env.clone(),
                            });
                            self.frames.push(MachineFrame::Eval { node: *primary });
                        }
                        PlanNode::Map {
                            collection,
                            element,
                            body,
                        } => match resolve_value(&collection, &self.env) {
                            Ok(JsonValue::Array(items)) if items.len() <= MAX_MAP_ELEMENTS => {
                                if items.is_empty() {
                                    self.signal = Some(MachineSignal::Value {
                                        value: JsonValue::Array(Vec::new()),
                                    });
                                    continue;
                                }
                                let saved_env = self.env.clone();
                                self.env.insert(element.clone(), items[0].clone());
                                self.frames.push(MachineFrame::MapItem {
                                    items,
                                    next: 1,
                                    element,
                                    body: *body.clone(),
                                    results: Vec::new(),
                                    saved_env,
                                });
                                self.frames.push(MachineFrame::Eval { node: *body });
                            }
                            Ok(JsonValue::Array(items)) => self.raise(EvalError::from(format!(
                                "(map ...) 的集合有 {} 个元素，超过单次上限 {MAX_MAP_ELEMENTS}；请先收窄它",
                                items.len()
                            ))),
                            Ok(other) => self.raise(EvalError::from(format!(
                                "(map ...) 只能迭代数组，得到 {}",
                                type_name(&other)
                            ))),
                            Err(error) => self.raise(error),
                        },
                        PlanNode::Infer { arguments } => {
                            if self.budget.infers_left == 0 {
                                self.raise(EvalError::from(format!(
                                    "程序的 infer 次数超过上限 {MAX_PROGRAM_INFERS}"
                                )));
                                continue;
                            }
                            match build_arguments(&arguments, &self.env, None) {
                                Ok(request) => {
                                    self.budget.infers_left -= 1;
                                    let effect = PlanEffect::Infer {
                                        sequence: self.take_effect_sequence(),
                                        request,
                                        tools: self.declared_tools.clone(),
                                    };
                                    self.pending = Some(effect.clone());
                                    return PlanAdvance::Suspended(effect);
                                }
                                Err(error) => self.raise(error),
                            }
                        }
                        PlanNode::Call { tool, arguments } => {
                            if self.budget.calls_left == 0 {
                                self.raise(EvalError::from(format!(
                                    "程序的工具调用次数超过上限 {MAX_PROGRAM_CALLS}"
                                )));
                                continue;
                            }
                            let Some(runtime_tool) = registry.get(&tool) else {
                                self.raise(EvalError::from(format!("工具 '{tool}' 不存在")));
                                continue;
                            };
                            let schema = runtime_tool.definition().parameters.clone();
                            match build_arguments(&arguments, &self.env, Some(&schema)) {
                                Ok(arguments) => {
                                    self.budget.calls_left -= 1;
                                    let effect = PlanEffect::Call {
                                        sequence: self.take_effect_sequence(),
                                        tool,
                                        arguments,
                                    };
                                    self.pending = Some(effect.clone());
                                    return PlanAdvance::Suspended(effect);
                                }
                                Err(error) => self.raise(error),
                            }
                        }
                    }
                }
                MachineFrame::Seq { steps, next } => {
                    let Some(signal) = self.signal.take() else {
                        return self.fail_internal("seq continuation 缺少前一步结果");
                    };
                    match signal {
                        failure @ MachineSignal::Failure { .. } => {
                            self.signal = Some(failure);
                        }
                        value @ MachineSignal::Value { .. } if next >= steps.len() => {
                            self.signal = Some(value);
                        }
                        MachineSignal::Value { .. } => {
                            let node = steps[next].clone();
                            self.frames.push(MachineFrame::Seq {
                                steps,
                                next: next + 1,
                            });
                            self.frames.push(MachineFrame::Eval { node });
                        }
                    }
                }
                MachineFrame::Bind { name } => {
                    let Some(signal) = self.signal.take() else {
                        return self.fail_internal("bind continuation 缺少被绑定值");
                    };
                    match signal {
                        MachineSignal::Value { value } => {
                            self.env.insert(name, value);
                            self.signal = Some(MachineSignal::Value {
                                value: JsonValue::Null,
                            });
                        }
                        failure @ MachineSignal::Failure { .. } => {
                            self.signal = Some(failure);
                        }
                    }
                }
                MachineFrame::RestoreScope { saved_env } => {
                    if self.signal.is_none() {
                        return self.fail_internal("局部作用域结束时缺少结果");
                    }
                    self.env = saved_env;
                }
                MachineFrame::FallbackPrimary { backup, saved_env } => {
                    let Some(signal) = self.signal.take() else {
                        return self.fail_internal("fallback primary 缺少结果");
                    };
                    self.env = saved_env.clone();
                    match signal {
                        value @ MachineSignal::Value { .. } => self.signal = Some(value),
                        MachineSignal::Failure { .. } => {
                            self.frames.push(MachineFrame::RestoreScope { saved_env });
                            self.frames.push(MachineFrame::Eval { node: backup });
                        }
                    }
                }
                MachineFrame::MapItem {
                    items,
                    next,
                    element,
                    body,
                    mut results,
                    saved_env,
                } => {
                    let Some(signal) = self.signal.take() else {
                        return self.fail_internal("map body 缺少结果");
                    };
                    self.env = saved_env.clone();
                    match signal {
                        MachineSignal::Failure { message } => {
                            self.signal = Some(MachineSignal::Failure { message });
                        }
                        MachineSignal::Value { value } => {
                            results.push(value);
                            if next >= items.len() {
                                self.signal = Some(MachineSignal::Value {
                                    value: JsonValue::Array(results),
                                });
                            } else {
                                self.env.insert(element.clone(), items[next].clone());
                                self.frames.push(MachineFrame::MapItem {
                                    items,
                                    next: next + 1,
                                    element,
                                    body: body.clone(),
                                    results,
                                    saved_env,
                                });
                                self.frames.push(MachineFrame::Eval { node: body });
                            }
                        }
                    }
                }
            }
        }
    }

    /// Supplies the result of the exact pending effect.  The sequence is a
    /// causal fence: an old child completion cannot resume a newer suspension.
    pub fn resume_effect(
        &mut self,
        sequence: u64,
        outcome: Result<JsonValue, String>,
    ) -> Result<(), EvalError> {
        let Some(effect) = self.pending.as_ref() else {
            return err("Plan Machine 当前没有等待任何 effect".to_string());
        };
        if effect.sequence() != sequence {
            return err(format!(
                "Plan effect sequence 不匹配：等待 {}，收到 {sequence}",
                effect.sequence()
            ));
        }
        let effect = self.pending.take().expect("checked above");
        self.signal = Some(match outcome {
            Ok(value) => MachineSignal::Value { value },
            Err(message) => MachineSignal::Failure {
                message: effect.failure(message),
            },
        });
        Ok(())
    }

    fn take_effect_sequence(&mut self) -> u64 {
        let sequence = self.next_effect_sequence;
        self.next_effect_sequence = self.next_effect_sequence.saturating_add(1);
        sequence
    }

    fn raise(&mut self, error: EvalError) {
        self.signal = Some(MachineSignal::Failure {
            message: error.message,
        });
    }

    fn fail_internal(&mut self, message: impl Into<String>) -> PlanAdvance {
        let terminal = MachineTerminal::Failed {
            message: message.into(),
        };
        self.terminal = Some(terminal.clone());
        terminal.into()
    }
}

impl From<MachineTerminal> for PlanAdvance {
    fn from(value: MachineTerminal) -> Self {
        match value {
            MachineTerminal::Complete { value } => Self::Complete(value),
            MachineTerminal::Failed { message } => Self::Failed(EvalError::from(message)),
        }
    }
}

/// Evaluates a validated program.
///
/// Every `call` goes through the registry, so each tool keeps its own path
/// resolution, jail and permission checks. This evaluator adds sequencing and
/// data flow; it does not add reach.
pub async fn evaluate(
    program: &Program,
    registry: Arc<Registry>,
    host: Arc<dyn RuntimeInference>,
) -> Result<JsonValue, EvalError> {
    let mut machine = PlanMachine::new(program)?;
    loop {
        match machine.advance(&registry) {
            PlanAdvance::Complete(value) => return Ok(value),
            PlanAdvance::Failed(error) => return Err(error),
            PlanAdvance::Suspended(effect) => {
                let sequence = effect.sequence();
                let outcome = match effect {
                    PlanEffect::Call {
                        tool, arguments, ..
                    } => {
                        let runtime_tool = registry.get(&tool).ok_or_else(|| {
                            EvalError::from(format!("工具 '{tool}' 在 effect 交付前消失"))
                        })?;
                        let payload = serde_json::to_string(&JsonValue::Object(arguments))
                            .map_err(|error| EvalError::from(format!("参数序列化失败: {error}")))?;
                        runtime_tool
                            .execute(&payload)
                            .await
                            .map(as_json)
                            .map_err(|error| error.to_string())
                    }
                    PlanEffect::Infer { request, tools, .. } => host
                        .infer(&request, tools.as_deref())
                        .await
                        .map(JsonValue::String)
                        .map_err(|error| error.to_string()),
                };
                machine.resume_effect(sequence, outcome)?;
            }
        }
    }
}

/// Turns `(name value...)` pair lists into the standard JSON tool arguments
/// the production contract speaks of. This is where the deterministic
/// evaluator does its own job instead of teaching the model notation: with
/// the tool's schema in hand, a lone value destined for an array parameter is
/// wrapped, and several values under one name form an array.
fn build_arguments(
    args: &[PlanArgument],
    env: &HashMap<String, JsonValue>,
    schema: Option<&JsonValue>,
) -> Result<JsonMap<String, JsonValue>, EvalError> {
    let properties = schema
        .and_then(|schema| schema.get("properties"))
        .and_then(|properties| properties.as_object());
    let mut arguments = JsonMap::new();
    for argument in args {
        let mut values = Vec::with_capacity(argument.values.len());
        for value in &argument.values {
            values.push(resolve_value(value, env)?);
        }
        let expects_array = properties
            .and_then(|properties| properties.get(argument.name.as_str()))
            .and_then(|property| property.get("type"))
            .and_then(|kind| kind.as_str())
            == Some("array");
        let value = if values.len() > 1 {
            JsonValue::Array(values)
        } else if expects_array {
            let single = values.pop().expect("length checked above");
            match single {
                JsonValue::Array(existing) => JsonValue::Array(existing),
                scalar => JsonValue::Array(vec![scalar]),
            }
        } else {
            values.pop().expect("length checked above")
        };
        arguments.insert(argument.name.clone(), value);
    }
    Ok(arguments)
}

/// Resolves a value position: `$name` and `$name.field` read the environment,
/// anything else is the literal the model wrote.
fn resolve_value(
    value: &PlanValue,
    env: &HashMap<String, JsonValue>,
) -> Result<JsonValue, EvalError> {
    let PlanValue::Reference(reference) = value else {
        let PlanValue::Literal(atom) = value else {
            unreachable!()
        };
        return Ok(literal(atom));
    };
    let mut parts = reference.split('.');
    let name = parts.next().unwrap_or_default();
    let mut current = env
        .get(name)
        .ok_or_else(|| EvalError::from(format!("'${name}' 尚未绑定")))?
        .clone();
    for field in parts {
        current = match current {
            JsonValue::Object(mut fields) => fields.remove(field).unwrap_or(JsonValue::Null),
            other => {
                return err(format!(
                    "'${reference}' 无法取字段：'{name}' 是 {}",
                    type_name(&other)
                ))
            }
        };
    }
    Ok(current)
}

/// Literals stay close to what the model wrote. Numbers and booleans are
/// recognized so a tool that expects them does not receive a string.
fn literal(atom: &str) -> JsonValue {
    match atom {
        "true" => JsonValue::Bool(true),
        "false" => JsonValue::Bool(false),
        "null" => JsonValue::Null,
        other => other
            .parse::<i64>()
            .map(JsonValue::from)
            .or_else(|_| other.parse::<f64>().map(JsonValue::from))
            .unwrap_or_else(|_| JsonValue::String(other.to_string())),
    }
}

/// Tool output is a string; when it happens to be JSON the program can address
/// into it, and when it does not it stays a string.
fn as_json(output: String) -> JsonValue {
    serde_json::from_str(&output).unwrap_or(JsonValue::String(output))
}

fn truthy(value: &JsonValue) -> bool {
    match value {
        JsonValue::Null => false,
        JsonValue::Bool(flag) => *flag,
        JsonValue::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        JsonValue::String(text) => !text.is_empty(),
        JsonValue::Array(items) => !items.is_empty(),
        JsonValue::Object(fields) => !fields.is_empty(),
    }
}

fn type_name(value: &JsonValue) -> &'static str {
    match value {
        JsonValue::Null => "null",
        JsonValue::Bool(_) => "布尔值",
        JsonValue::Number(_) => "数字",
        JsonValue::String(_) => "字符串",
        JsonValue::Array(_) => "数组",
        JsonValue::Object(_) => "对象",
    }
}

tokio::task_local! {
    /// Set by the Orchestrator around an `eval`, this is how a program reaches
    /// the model without the evaluator holding the Orchestrator that holds it.
    pub static CURRENT_INFERENCE: Option<Arc<dyn RuntimeInference>>;
}

/// Production execution boundary for a validated Runtime-owned Plan.
///
/// `EvalTool` owns only the Yao surface and static validation. The injected
/// implementation owns durable Plan identity, Scheduler hand-off, approval,
/// physical execution and recovery. Keeping this seam separate from
/// [`RuntimeInference`] prevents the legacy in-process interpreter from
/// accidentally becoming a second scheduler.
#[async_trait::async_trait]
pub trait RuntimePlanExecutor: Send + Sync {
    async fn execute_plan(
        &self,
        program: Program,
    ) -> Result<JsonValue, Box<dyn std::error::Error + Send + Sync>>;
}

tokio::task_local! {
    /// Set by the Orchestrator for one outer `eval` Function Call.
    ///
    /// Tests and embedders which have not assembled the Scheduler Kernel may
    /// omit it and exercise the legacy pure interpreter through
    /// [`CURRENT_INFERENCE`]. Product assembly always injects this channel.
    pub static CURRENT_PLAN_EXECUTOR: Option<Arc<dyn RuntimePlanExecutor>>;
}

/// Tools an `eval` program may call when nothing is configured.
///
/// Read-only and in-workspace only, for a reason that outlives v1: the tree is
/// admitted as a whole, before evaluation discovers the paths a `map` will
/// reach. A write or an out-of-boundary path found mid-evaluation could not
/// have been part of what was admitted, so the program is refused rather than
/// escalated. Individual tools still run their own jail and path checks.
///
/// An operator may widen or narrow this through configuration. Both `call`
/// and nested `infer` inside a Runtime-owned `(eval ...)` read this same list
/// — see `eval_callable_tools`. A model-owned top-level `(infer ...)` Harness
/// instead declares a narrowing of the ordinary Function Calling surface; it
/// never executes through `EvalTool`.
pub const DEFAULT_CALLABLE_TOOLS: [&str; 3] = ["read", "list_files", "search"];

pub struct EvalTool {
    registry: Arc<Registry>,
    callable: Vec<String>,
}

impl EvalTool {
    pub fn new(registry: Arc<Registry>, callable: Vec<String>) -> Self {
        Self { registry, callable }
    }

    /// Construction for callers with no configuration of their own, such as
    /// tests, so the default set lives in exactly one place.
    pub fn with_default_tools(registry: Arc<Registry>) -> Self {
        Self::new(
            registry,
            DEFAULT_CALLABLE_TOOLS
                .iter()
                .map(|name| (*name).to_string())
                .collect(),
        )
    }

    /// Built from the tables and the configured list, so what the model is told
    /// it may write cannot drift from what the validator will accept.
    pub fn description(callable: &[String]) -> String {
        let tools = if callable.is_empty() {
            "（本部署未开放树内工具调用；程序只能使用结构与 infer）".to_string()
        } else {
            format!(
                "{}（其余工具请用普通 Function Calling）",
                callable.join(" ")
            )
        };
        format!(
            "把一棵可求值的 S 表达式程序交给 Runtime 确定性执行，一次完成多个有数据依赖的步骤。\
             适用于步骤提前已知、且后一步要用到前一步结果的场合；单步或需要看到结果再决定时，\
             继续使用普通 Function Calling 即可，本工具不替代它。\n\
             本工具只接受显式 (eval ...) 根；模型主导的 (infer ...) 由 Runtime 创建正式 Evaluation，不提交给本工具。\n\
             (eval ...) 内可先放 (requires (tools NAME...)) 收窄能力，随后必须恰好有一个程序体；多个步骤用 (seq ...) 组合。\n\
             声明不能超出下方工具清单，声明后 call 与 infer 取证都只限声明过的工具。\n\
             可调用工具：{tools}\n\
             `reply` 与 `process` 属于你自身的求值，本程序中不可用。\n\
             算子契约：\n{contract}\n\
             示例：\n\
             (eval\n\
               (requires (tools list_files read))\n\
               (seq\n\
                 (bind files (call list_files (path \"src\")))\n\
                 (bind bodies (map $files f (call read (path $f))))\n\
                 (infer (task \"哪些文件含 TODO\") (evidence $bodies))))",
            contract = operator_contract(),
        )
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct EvalArgs {
    program: String,
}

#[async_trait::async_trait]
impl crate::tool::Tool for EvalTool {
    fn name(&self) -> &str {
        "eval"
    }

    /// The tree is a Runtime control construct, not a reality-facing action of
    /// its own: a physical Job could be dispatched to an edge worker, and
    /// `infer` has to reach the Orchestrator's model path from wherever it runs.
    fn execution_class(&self) -> crate::tool::ToolExecutionClass {
        crate::tool::ToolExecutionClass::LogicalInline
    }

    fn definition(&self) -> crate::llm::ToolDefinition {
        crate::llm::ToolDefinition {
            name: "eval".to_string(),
            description: Self::description(&self.callable),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "program": {
                        "type": "string",
                        "description": "带显式 eval 根的 canonical Yao 程序，例如 (eval (seq (bind files (call list_files (path \"src\"))) (map $files f (call read (path $f)))))"
                    }
                },
                "required": ["program"]
            }),
        }
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: EvalArgs = serde_json::from_str(arguments)?;
        let gate = AllowList::new(self.callable.clone());
        let program = validate(&args.program, &self.registry, &gate)?;
        if let Some(executor) = CURRENT_PLAN_EXECUTOR.try_with(Clone::clone).ok().flatten() {
            let value = executor.execute_plan(program).await?;
            return Ok(serde_json::to_string(&value)?);
        }
        let inference = CURRENT_INFERENCE
            .try_with(Clone::clone)
            .ok()
            .flatten()
            .ok_or("eval 缺少 Runtime 注入的模型调用通道")?;
        let value = evaluate(&program, Arc::clone(&self.registry), inference).await?;
        Ok(serde_json::to_string(&value)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    };

    /// Records every invocation so a test can assert on what physically ran,
    /// not merely on the value that came back.
    struct RecordingTool {
        name: &'static str,
        reply: JsonValue,
        seen: Arc<Mutex<Vec<String>>>,
    }

    #[async_trait::async_trait]
    impl crate::tool::Tool for RecordingTool {
        fn name(&self) -> &str {
            self.name
        }

        fn definition(&self) -> crate::llm::ToolDefinition {
            crate::llm::ToolDefinition {
                name: self.name.to_string(),
                description: String::new(),
                parameters: serde_json::json!({"type": "object"}),
            }
        }

        async fn execute(
            &self,
            arguments: &str,
        ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
            self.seen
                .lock()
                .unwrap()
                .push(format!("{}:{arguments}", self.name));
            Ok(self.reply.to_string())
        }
    }

    fn fixture(replies: &[(&'static str, JsonValue)]) -> (Arc<Registry>, Arc<Mutex<Vec<String>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let registry = Registry::new();
        for (name, reply) in replies {
            registry.register(Arc::new(RecordingTool {
                name,
                reply: reply.clone(),
                seen: Arc::clone(&seen),
            }));
        }
        (Arc::new(registry), seen)
    }

    fn gate() -> AllowList {
        AllowList::new(["list_files", "read", "search"])
    }

    /// Answers every `infer` with a fixed string and records the request, so a
    /// test can assert on the viewport the program actually handed the model.
    struct ScriptedHost {
        answer: String,
        seen: Arc<Mutex<Vec<JsonMap<String, JsonValue>>>>,
        tools_offered: Arc<Mutex<Vec<Option<Vec<String>>>>>,
    }

    struct ScriptedPlanExecutor {
        called: Arc<AtomicBool>,
        result: JsonValue,
    }

    #[async_trait::async_trait]
    impl RuntimePlanExecutor for ScriptedPlanExecutor {
        async fn execute_plan(
            &self,
            _program: Program,
        ) -> Result<JsonValue, Box<dyn std::error::Error + Send + Sync>> {
            self.called.store(true, Ordering::SeqCst);
            Ok(self.result.clone())
        }
    }

    #[async_trait::async_trait]
    impl RuntimeInference for ScriptedHost {
        async fn infer(
            &self,
            request: &JsonMap<String, JsonValue>,
            tools: Option<&[String]>,
        ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
            self.seen.lock().unwrap().push(request.clone());
            self.tools_offered
                .lock()
                .unwrap()
                .push(tools.map(<[String]>::to_vec));
            Ok(self.answer.clone())
        }
    }

    type SeenRequests = Arc<Mutex<Vec<JsonMap<String, JsonValue>>>>;

    fn host(answer: &str) -> (Arc<dyn RuntimeInference>, SeenRequests) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let host = ScriptedHost {
            answer: answer.to_string(),
            seen: Arc::clone(&seen),
            tools_offered: Arc::new(Mutex::new(Vec::new())),
        };
        (Arc::new(host), seen)
    }

    async fn run(
        source: &str,
        replies: &[(&'static str, JsonValue)],
    ) -> (Result<JsonValue, EvalError>, Vec<String>) {
        let (registry, seen) = fixture(replies);
        let (inference, _) = host("inferred");
        let source = format!("(eval {source})");
        let outcome = match validate(&source, &registry, &gate()) {
            Ok(program) => evaluate(&program, Arc::clone(&registry), inference).await,
            Err(error) => Err(error),
        };
        let calls = seen.lock().unwrap().clone();
        (outcome, calls)
    }

    #[tokio::test]
    async fn a_bound_result_fans_out_through_map() {
        // The point of the whole evaluator: the collection is not known when
        // the model writes the program, so it cannot unroll this itself.
        let (outcome, calls) = run(
            r#"(seq
                 (bind files (call list_files (path "src")))
                 (map $files entry (call read (path $entry))))"#,
            &[
                ("list_files", serde_json::json!(["a.rs", "b.rs"])),
                ("read", serde_json::json!({"text": "ok"})),
            ],
        )
        .await;
        assert_eq!(
            outcome.unwrap(),
            serde_json::json!([{"text": "ok"}, {"text": "ok"}])
        );
        assert_eq!(calls.len(), 3);
        assert!(calls[1].contains("\"path\":\"a.rs\""), "calls: {calls:?}");
        assert!(calls[2].contains("\"path\":\"b.rs\""), "calls: {calls:?}");
    }

    #[tokio::test]
    async fn only_the_taken_branch_reaches_a_tool() {
        let (outcome, calls) = run(
            r#"(seq
                 (bind hits (call search (query "铜印")))
                 (if $hits (call read (path "found.rs")) (call read (path "missing.rs"))))"#,
            &[
                ("search", serde_json::json!([])),
                ("read", serde_json::json!("body")),
            ],
        )
        .await;
        assert_eq!(outcome.unwrap(), serde_json::json!("body"));
        assert_eq!(calls.len(), 2, "untaken branch must not run: {calls:?}");
        assert!(calls[1].contains("missing.rs"), "calls: {calls:?}");
    }

    #[tokio::test]
    async fn fallback_runs_only_after_a_classified_failure() {
        let (outcome, calls) = run(
            r#"(seq
                 (bind scalar (call read (path "shape.txt")))
                 (fallback
                   (map $scalar item (call read (path $item)))
                   (call read (path "backup.txt"))))"#,
            &[("read", serde_json::json!("not-an-array"))],
        )
        .await;
        assert_eq!(outcome.unwrap(), serde_json::json!("not-an-array"));
        assert_eq!(calls.len(), 2, "backup should run exactly once: {calls:?}");
        assert!(calls[1].contains("backup.txt"), "calls: {calls:?}");
    }

    #[tokio::test]
    async fn field_access_reads_into_a_bound_result() {
        let (outcome, _) = run(
            r#"(seq
                 (bind found (call search (query "x")))
                 (call read (path $found.path)))"#,
            &[
                ("search", serde_json::json!({"path": "hit.rs"})),
                ("read", serde_json::json!("body")),
            ],
        )
        .await;
        assert_eq!(outcome.unwrap(), serde_json::json!("body"));
    }

    #[tokio::test]
    async fn rejections_name_the_repair() {
        let registry = fixture(&[("read", JsonValue::Null)]).0;
        let cases = [
            // An operator the model was told it has, but which belongs to its
            // own evaluation rather than this one.
            ("(reply \"done\")", "只用于你自身的求值"),
            ("(loop (call read (path \"a\")))", "未知算子"),
            (
                "(call exec (command \"rm -rf /\"))",
                "不能在 eval 程序中调用",
            ),
            ("(call nope (path \"a\"))", "不能在 eval 程序中调用"),
            ("(seq (call read (path $missing)))", "未绑定"),
            (
                "(seq (bind a (call read (path \"x\"))) (bind a (call read (path \"y\"))))",
                "不可覆盖",
            ),
            ("(call read (path))", "缺少值"),
            ("(call read path)", "必须是 (参数名 值...) 列表"),
            ("(seq (bind $a (call read (path \"x\"))))", "名字不带 $"),
        ];
        for (source, expected) in cases {
            let source = format!("(eval {source})");
            let error = validate(&source, &registry, &gate())
                .expect_err(&format!("must reject: {source}"))
                .message;
            assert!(
                error.contains(expected),
                "for {source}\n  expected to mention: {expected}\n  got: {error}"
            );
        }
    }

    #[tokio::test]
    async fn a_branch_binding_does_not_escape_its_branch() {
        let registry = fixture(&[("read", JsonValue::Null)]).0;
        let error = validate(
            r#"(eval (seq
                 (if true (bind inner (call read (path "a"))) (call read (path "b")))
                 (call read (path $inner))))"#,
            &registry,
            &gate(),
        )
        .expect_err("a binding from an untaken branch cannot be referenced")
        .message;
        assert!(error.contains("未绑定"), "got: {error}");
    }

    #[tokio::test]
    async fn iteration_is_bounded_and_typed() {
        let oversized = (0..MAX_MAP_ELEMENTS + 1)
            .map(|index| index.to_string())
            .collect::<Vec<_>>();
        let (outcome, _) = run(
            r#"(seq (bind files (call list_files (path "src"))) (map $files e (call read (path $e))))"#,
            &[
                ("list_files", serde_json::json!(oversized)),
                ("read", JsonValue::Null),
            ],
        )
        .await;
        assert!(outcome.unwrap_err().message.contains("超过单次上限"));

        let (outcome, _) = run(
            r#"(seq (bind one (call read (path "a"))) (map $one e (call read (path $e))))"#,
            &[("read", serde_json::json!("not-an-array"))],
        )
        .await;
        assert!(outcome.unwrap_err().message.contains("只能迭代数组"));
    }

    #[tokio::test]
    async fn depth_is_rejected_before_anything_runs() {
        let registry = fixture(&[("read", JsonValue::Null)]).0;
        let mut source = "(call read (path \"a\"))".to_string();
        for _ in 0..MAX_PROGRAM_DEPTH + 1 {
            source = format!("(seq {source})");
        }
        source = format!("(eval {source})");
        let error = validate(&source, &registry, &gate())
            .expect_err("deep programs are refused")
            .message;
        assert!(error.contains("嵌套超过"), "got: {error}");
    }

    #[tokio::test]
    async fn declared_tools_are_reported_for_capability_settlement() {
        let registry = fixture(&[("list_files", JsonValue::Null), ("read", JsonValue::Null)]).0;
        let program = validate(
            r#"(eval (seq (bind f (call list_files (path "src"))) (map $f e (call read (path $e)))))"#,
            &registry,
            &gate(),
        )
        .unwrap();
        assert_eq!(program.tools(), ["list_files", "read"]);
    }

    #[tokio::test]
    async fn evaluation_hands_control_back_to_the_model_and_resumes() {
        // The trampoline: Runtime evaluates, stops at `infer`, takes the value
        // back, and keeps evaluating with it bound.
        let (registry, _) = fixture(&[
            ("read", serde_json::json!("沈砚握紧了铜印")),
            ("search", JsonValue::Null),
        ]);
        let (inference, requests) = host("两半");
        let program = validate(
            r#"(eval (seq
                 (bind body (call read (path "ch041.md")))
                 (bind form (infer (task "铜印现在是什么形态") (evidence $body)))
                 (call search (query $form))))"#,
            &registry,
            &gate(),
        )
        .unwrap();
        let value = evaluate(&program, Arc::clone(&registry), inference)
            .await
            .unwrap();
        assert_eq!(value, JsonValue::Null);

        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        // The declared arguments are the whole viewport: the tool result the
        // program chose to pass, and nothing the Runtime added on its own.
        assert_eq!(
            requests[0].get("task").and_then(JsonValue::as_str),
            Some("铜印现在是什么形态")
        );
        assert_eq!(
            requests[0].get("evidence").and_then(JsonValue::as_str),
            Some("沈砚握紧了铜印")
        );
    }

    #[tokio::test]
    async fn infer_must_say_what_it_is_asking() {
        let registry = fixture(&[]).0;
        let error = validate(r#"(infer (evidence "x"))"#, &registry, &gate())
            .expect_err("an infer without a task has no question")
            .message;
        assert!(error.contains("(task"), "got: {error}");
    }

    #[tokio::test]
    async fn model_requests_are_capped() {
        let items = (0..MAX_PROGRAM_INFERS + 1)
            .map(|index| index.to_string())
            .collect::<Vec<_>>();
        let (registry, _) = fixture(&[("list_files", serde_json::json!(items))]);
        let (inference, requests) = host("ok");
        let program = validate(
            r#"(eval (seq (bind f (call list_files (path "src"))) (map $f e (infer (task "看一下") (item $e)))))"#,
            &registry,
            &gate(),
        )
        .unwrap();
        let error = evaluate(&program, registry, inference)
            .await
            .expect_err("the model request budget is enforced")
            .message;
        assert!(error.contains("infer 次数超过上限"), "got: {error}");
        assert_eq!(requests.lock().unwrap().len(), MAX_PROGRAM_INFERS);
    }

    #[tokio::test]
    async fn the_tool_validates_then_evaluates_behind_one_call() {
        use crate::tool::Tool;

        let (registry, calls) = fixture(&[
            ("list_files", serde_json::json!(["a.rs", "b.rs"])),
            ("read", serde_json::json!("body")),
        ]);
        let tool = EvalTool::with_default_tools(Arc::clone(&registry));
        let arguments = serde_json::json!({
            "program": r#"(eval (seq (bind f (call list_files (path "src"))) (map $f e (call read (path $e)))))"#
        })
        .to_string();
        let output = CURRENT_INFERENCE
            .scope(Some(host("unused").0), tool.execute(&arguments))
            .await
            .unwrap();
        assert_eq!(output, r#"["body","body"]"#);
        assert_eq!(calls.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn the_tool_hands_a_validated_program_to_the_runtime_plan_executor() {
        use crate::tool::Tool;

        let registry = fixture(&[("read", JsonValue::Null)]).0;
        let tool = EvalTool::with_default_tools(registry);
        let called = Arc::new(AtomicBool::new(false));
        let executor: Arc<dyn RuntimePlanExecutor> = Arc::new(ScriptedPlanExecutor {
            called: Arc::clone(&called),
            result: serde_json::json!({"source": "durable-plan"}),
        });
        let arguments =
            serde_json::json!({"program": r#"(eval (call read (path "a.rs")))"#}).to_string();

        let output = CURRENT_PLAN_EXECUTOR
            .scope(
                Some(executor),
                CURRENT_INFERENCE.scope(None, tool.execute(&arguments)),
            )
            .await
            .unwrap();

        assert!(called.load(Ordering::SeqCst));
        assert_eq!(output, r#"{"source":"durable-plan"}"#);
    }

    #[tokio::test]
    async fn the_tool_refuses_a_program_before_running_any_of_it() {
        use crate::tool::Tool;

        let (registry, calls) = fixture(&[("read", JsonValue::Null)]);
        let tool = EvalTool::with_default_tools(Arc::clone(&registry));
        // `exec` is outside the read-only gate, and it sits after a legitimate
        // read: nothing may run if the tree as a whole is not admissible.
        let arguments = serde_json::json!({
            "program": r#"(eval (seq (call read (path "a")) (call exec (command "rm -rf /"))))"#
        })
        .to_string();
        let error = CURRENT_INFERENCE
            .scope(Some(host("unused").0), tool.execute(&arguments))
            .await
            .expect_err("an inadmissible tree is refused whole")
            .to_string();
        assert!(error.contains("不能在 eval 程序中调用"), "got: {error}");
        assert!(
            calls.lock().unwrap().is_empty(),
            "validation must precede every side effect"
        );
    }

    #[tokio::test]
    async fn the_tool_says_so_when_the_model_channel_is_missing() {
        use crate::tool::Tool;

        let registry = fixture(&[]).0;
        let tool = EvalTool::with_default_tools(registry);
        let arguments = serde_json::json!({"program": r#"(infer (task "判断"))"#}).to_string();
        let error = CURRENT_INFERENCE
            .scope(None, tool.execute(&arguments))
            .await
            .expect_err("without the channel the program cannot be evaluated")
            .to_string();
        assert!(error.contains("模型调用通道"), "got: {error}");
    }

    #[test]
    fn the_advertised_operators_are_the_implemented_ones() {
        // The description is the model's only account of what it may write, so
        // it is generated from the tables rather than restated by hand.
        let callable = DEFAULT_CALLABLE_TOOLS
            .iter()
            .map(|name| (*name).to_string())
            .collect::<Vec<_>>();
        let description = EvalTool::description(&callable);
        let contract = operator_contract();
        // Not just the names: the form and the meaning have to reach the model
        // too, or it is left guessing at the surface — which is what the first
        // evaluation showed it doing.
        for spec in OPERATORS
            .iter()
            .filter(|spec| spec.available != Availability::LlmOnly)
        {
            assert!(description.contains(spec.name), "missing {}", spec.name);
            assert!(
                description.contains(spec.form),
                "missing form for {}",
                spec.name
            );
            // Compared against the rendered contract rather than the raw
            // literal: quoting escapes embedded quotes on the way out.
            assert!(
                contract.contains(spec.description)
                    || contract.contains(&format!("{:?}", spec.description)),
                "missing description for {}",
                spec.name
            );
        }
        for spec in OPERATORS
            .iter()
            .filter(|spec| spec.available == Availability::LlmOnly)
        {
            if spec.name == "reply" {
                continue;
            }
            assert!(description.contains(spec.name), "unexplained {}", spec.name);
        }
    }

    #[tokio::test]
    async fn the_configured_gate_replaces_the_default_one() {
        use crate::tool::Tool;

        let (registry, calls) = fixture(&[("read", JsonValue::Null)]);
        // A deployment that narrows the set must actually narrow it, and the
        // description has to say so rather than advertise the default.
        let tool = EvalTool::new(Arc::clone(&registry), vec!["search".to_string()]);
        // The gate line lists only what is callable; operator forms elsewhere
        // in the contract may legitimately mention other names.
        assert!(tool.definition().description.contains("可调用工具：search"));

        let arguments =
            serde_json::json!({"program": r#"(eval (call read (path "a")))"#}).to_string();
        let error = CURRENT_INFERENCE
            .scope(Some(host("unused").0), tool.execute(&arguments))
            .await
            .expect_err("a tool outside the configured gate is refused")
            .to_string();
        assert!(error.contains("只接受 search"), "got: {error}");
        assert!(calls.lock().unwrap().is_empty());
    }

    #[test]
    fn an_absent_configuration_keeps_the_default_gate() {
        // Nothing configured must mean the read-only default, not an empty gate
        // that would silently disable every `call` in every program.
        let configured = crate::config::OrchestratorConfig::default().eval_callable_tools;
        assert_eq!(configured, DEFAULT_CALLABLE_TOOLS);
    }

    #[test]
    fn an_empty_configuration_closes_the_gate_and_says_so() {
        let description = EvalTool::description(&[]);
        assert!(
            description.contains("未开放树内工具调用"),
            "an empty gate must be described, not left looking like the default: {description}"
        );
    }

    #[tokio::test]
    async fn a_declaration_narrows_calls_and_bounds_infer() {
        // Declared: search only. A call to read is refused even though the
        // deployment gate would allow it, and the infer host is offered
        // exactly the declaration — the part static analysis cannot reach.
        let (registry, _) = fixture(&[("search", serde_json::json!([]))]);
        let error = validate(
            r#"(eval (requires (tools search)) (call read (path "a")))"#,
            &registry,
            &gate(),
        )
        .expect_err("an undeclared call must be refused")
        .message;
        assert!(error.contains("只接受 search"), "got: {error}");

        let program = validate(
            r#"(eval (requires (tools search)) (seq (bind r (call search (query "x"))) (infer (task "判断") (hits $r))))"#,
            &registry,
            &gate(),
        )
        .unwrap();
        assert_eq!(program.declared_tools(), Some(&["search".to_string()][..]));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let offered = Arc::new(Mutex::new(Vec::new()));
        let host: Arc<dyn RuntimeInference> = Arc::new(ScriptedHost {
            answer: "ok".to_string(),
            seen,
            tools_offered: Arc::clone(&offered),
        });
        evaluate(&program, Arc::clone(&registry), host)
            .await
            .unwrap();
        assert_eq!(
            offered.lock().unwrap().as_slice(),
            &[Some(vec!["search".to_string()])]
        );
    }

    #[test]
    fn a_declaration_cannot_widen_the_deployment_gate() {
        // Asking for exec does not grant exec: the gate is the outer bound and
        // a program only ever narrows it.
        let registry = fixture(&[("read", JsonValue::Null)]).0;
        let error = validate(
            r#"(eval (requires (tools exec)) (call exec (command "ls")))"#,
            &registry,
            &gate(),
        )
        .expect_err("a declaration outside the gate is refused")
        .message;
        assert!(error.contains("不能在 eval 程序中调用"), "got: {error}");
    }

    #[tokio::test]
    async fn an_undeclared_program_keeps_the_old_meaning() {
        let (outcome, calls) = run(
            r#"(seq (bind f (call list_files (path "src"))) (map $f e (call read (path $e))))"#,
            &[
                ("list_files", serde_json::json!(["a.rs"])),
                ("read", serde_json::json!("body")),
            ],
        )
        .await;
        assert_eq!(outcome.unwrap(), serde_json::json!(["body"]));
        assert_eq!(calls.len(), 2);
    }

    #[test]
    fn shared_operators_match_the_production_contract_verbatim() {
        // One language, two evaluators: an operator available on both sides
        // has exactly one form. If this fails, someone grew a second dialect.
        let kernel = crate::sexpr_vm_contract::ANNOTATED_RESPONSE_KERNEL;
        for spec in OPERATORS
            .iter()
            .filter(|spec| spec.available == Availability::Both)
        {
            assert!(
                kernel.contains(&format!("(form {}", spec.form.trim_end_matches("...)")))
                    || kernel.contains(&format!("(form {})", spec.form))
                    || kernel.contains(spec.form),
                "operator '{}' 的 form '{}' 与生产契约不一致",
                spec.name,
                spec.form
            );
        }
    }

    #[test]
    fn literals_keep_the_type_the_model_wrote() {
        assert_eq!(literal("12"), serde_json::json!(12));
        assert_eq!(literal("true"), serde_json::json!(true));
        assert_eq!(literal("src/foo.rs"), serde_json::json!("src/foo.rs"));
    }

    #[test]
    fn evaluator_ownership_is_explicit_and_bare_bodies_are_rejected() {
        let registry = fixture(&[("read", JsonValue::Null)]).0;
        let error = validate(r#"(call read (path "README.md"))"#, &registry, &gate())
            .unwrap_err()
            .message;
        assert!(error.contains("显式使用"), "{error}");

        let model = validate(r#"(infer (task "判断当前状态"))"#, &registry, &gate()).unwrap();
        assert_eq!(model.owner(), EvaluationOwner::Model);
    }

    #[test]
    fn typed_plan_ir_round_trips_without_reparsing_yao() {
        let registry = fixture(&[("read", JsonValue::Null)]).0;
        let program = validate(
            r#"(eval
                 (requires (tools read))
                 (seq
                   (bind body (call read (path "README.md")))
                   (infer (task "归纳") (input $body))))"#,
            &registry,
            &gate(),
        )
        .unwrap();
        let encoded = serde_json::to_string(&program).unwrap();
        let restored: Program = serde_json::from_str(&encoded).unwrap();
        assert_eq!(restored, program);
        assert!(encoded.contains("\"op\":\"call\""));
        assert!(encoded.contains("\"kind\":\"reference\""));
    }

    #[test]
    fn plan_machine_replays_the_same_pending_effect_after_serialization() {
        let registry = fixture(&[
            ("list_files", serde_json::json!(["a.rs", "b.rs"])),
            ("read", serde_json::json!("unused")),
        ])
        .0;
        let program = validate(
            r#"(eval
                 (seq
                   (bind files (call list_files (path "src")))
                   (map $files file (call read (path $file)))))"#,
            &registry,
            &gate(),
        )
        .unwrap();
        let mut machine = PlanMachine::new(&program).unwrap();
        let first = match machine.advance(&registry) {
            PlanAdvance::Suspended(effect) => effect,
            other => panic!("expected first effect, got {other:?}"),
        };
        assert!(matches!(
            &first,
            PlanEffect::Call {
                sequence: 1,
                tool,
                arguments,
            } if tool == "list_files" && arguments["path"] == "src"
        ));

        let encoded = serde_json::to_string(&machine).unwrap();
        let mut restored: PlanMachine = serde_json::from_str(&encoded).unwrap();
        assert_eq!(
            restored.advance(&registry),
            PlanAdvance::Suspended(first.clone())
        );
        assert!(restored
            .resume_effect(99, Ok(serde_json::json!(["wrong"])))
            .is_err());
        assert_eq!(restored.pending_effect(), Some(&first));

        restored
            .resume_effect(first.sequence(), Ok(serde_json::json!(["a.rs", "b.rs"])))
            .unwrap();
        let second = match restored.advance(&registry) {
            PlanAdvance::Suspended(effect) => effect,
            other => panic!("expected second effect, got {other:?}"),
        };
        assert!(matches!(
            &second,
            PlanEffect::Call {
                sequence: 2,
                tool,
                arguments,
            } if tool == "read" && arguments["path"] == "a.rs"
        ));
        restored
            .resume_effect(second.sequence(), Ok(serde_json::json!("A")))
            .unwrap();
        let third = match restored.advance(&registry) {
            PlanAdvance::Suspended(effect) => effect,
            other => panic!("expected third effect, got {other:?}"),
        };
        assert!(matches!(
            &third,
            PlanEffect::Call {
                sequence: 3,
                tool,
                arguments,
            } if tool == "read" && arguments["path"] == "b.rs"
        ));
        restored
            .resume_effect(third.sequence(), Ok(serde_json::json!("B")))
            .unwrap();
        assert_eq!(
            restored.advance(&registry),
            PlanAdvance::Complete(serde_json::json!(["A", "B"]))
        );
    }

    #[test]
    fn plan_machine_routes_a_failed_effect_through_fallback() {
        let registry = fixture(&[("read", JsonValue::Null)]).0;
        let program = validate(
            r#"(eval
                 (fallback
                   (call read (path "primary"))
                   (call read (path "backup"))))"#,
            &registry,
            &gate(),
        )
        .unwrap();
        let mut machine = PlanMachine::new(&program).unwrap();
        let primary = match machine.advance(&registry) {
            PlanAdvance::Suspended(effect) => effect,
            other => panic!("expected primary effect, got {other:?}"),
        };
        machine
            .resume_effect(primary.sequence(), Err("not found".to_string()))
            .unwrap();
        let backup = match machine.advance(&registry) {
            PlanAdvance::Suspended(effect) => effect,
            other => panic!("expected backup effect, got {other:?}"),
        };
        assert!(matches!(
            &backup,
            PlanEffect::Call {
                tool,
                arguments,
                ..
            } if tool == "read" && arguments["path"] == "backup"
        ));
        machine
            .resume_effect(backup.sequence(), Ok(serde_json::json!("recovered")))
            .unwrap();
        assert_eq!(
            machine.advance(&registry),
            PlanAdvance::Complete(serde_json::json!("recovered"))
        );
    }
}
