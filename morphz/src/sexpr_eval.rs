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

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use sha2::{Digest, Sha256};

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

/// A Program Value may recursively launch only a finite number of child
/// Programs. The budget is transferred down the durable child chain and is
/// never replenished by restart.
pub const MAX_PROGRAM_VALUE_NESTING: usize = 4;

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
        description: "Evaluate each step from left to right and return the last step's value. To return a binding, place $name as the final step.",
        available: Availability::Both,
    },
    OperatorSpec {
        name: "bind",
        form: "(bind name expression)",
        description: "Fully evaluate expression, then bind it to name. Define name without $, reference it as $name, and access fields as $name.field. Bindings cannot be overwritten.",
        available: Availability::Both,
    },
    OperatorSpec {
        name: "call",
        form: "(call tool argument...)",
        description: "Call a tool. Arguments are standard JSON tool parameters written as (parameter value...) lists, for example (call read (path \"src/a.rs\")). Multiple values for one parameter form an array. Values must be literals or $references; the Runtime converts types according to the tool schema.",
        available: Availability::Both,
    },
    OperatorSpec {
        name: "if",
        form: "(if condition when-true when-false)",
        description: "condition must be a literal or $reference. Evaluate only the selected branch; the unselected branch makes no tool calls. Branch-local bindings do not escape the branch.",
        available: Availability::Both,
    },
    OperatorSpec {
        name: "map",
        form: "(map $collection element body)",
        description: "Evaluate body for each item in $collection and return an array. $collection must be a bound array. Define element without $ and reference it as $element inside body.",
        available: Availability::RuntimeEval,
    },
    OperatorSpec {
        name: "infer",
        form: "(infer (task \"what to determine\") (tools TOOL...) (returns text|json) argument...)",
        description: "Delegate a judgment to the nondeterministic evaluator (yourself). (task ...) is required; other (parameter value) entries are evidence. Optional (tools ...) narrows tools for this node, and empty (tools) means pure inference. Optional (returns ...) defaults to text. With returns=json, the final content must be one complete JSON value; the Runtime binds it only after successful parsing.",
        available: Availability::RuntimeEval,
    },
    OperatorSpec {
        name: "reply",
        form: "(reply content)",
        description: "Deliver a user-visible reply. This exists only in your own evaluation; a program submitted to the Runtime produces a value, not a reply.",
        available: Availability::LlmOnly,
    },
    OperatorSpec {
        name: "fallback",
        form: "(fallback primary backup)",
        description: "Evaluate primary first and evaluate backup only when primary returns a classified failure. A successful primary prevents all backup calls. Bindings in either branch do not escape it.",
        available: Availability::Both,
    },
    OperatorSpec {
        name: "process",
        form: "(process ...)",
        description: "Define a named process. This exists only in your own evaluation.",
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
    /// Structured source diagnostic when rejection happened in the Yao
    /// frontend. Runtime/execution failures need not carry source syntax.
    pub diagnostic: Option<Box<crate::yao::Diagnostic>>,
}

impl std::fmt::Display for EvalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for EvalError {}

impl From<String> for EvalError {
    fn from(message: String) -> Self {
        Self {
            message,
            diagnostic: None,
        }
    }
}

fn err<T>(message: impl Into<String>) -> Result<T, EvalError> {
    Err(EvalError {
        message: message.into(),
        diagnostic: None,
    })
}

fn parse_source_forms(source: &str) -> Result<Vec<SExpr>, EvalError> {
    crate::yao::parse_all(source, crate::yao::ParseLimits::default())
        .map(|forms| forms.iter().map(lower_spanned_sexpr).collect())
        .map_err(|diagnostic| EvalError {
            message: format!("program 不是合法的 Yao 源码: {diagnostic}"),
            diagnostic: Some(Box::new(diagnostic)),
        })
}

fn lower_spanned_sexpr(expression: &crate::yao::Expr) -> SExpr {
    match expression {
        crate::yao::Expr::Atom(atom) => SExpr::Atom(atom.value.clone()),
        crate::yao::Expr::List { items, .. } => {
            SExpr::List(items.iter().map(lower_spanned_sexpr).collect())
        }
    }
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

/// The value contract at the non-deterministic boundary.
///
/// `infer` still decides *what* the answer is; this only tells Runtime how the
/// answer crosses back into deterministic data flow.  Keeping the contract in
/// Typed Plan IR makes restart recovery apply the same decoding rule as the
/// initial in-process execution.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InferResultKind {
    #[default]
    Text,
    Json,
    /// A typed Yao value. The definitions travel with the durable effect so a
    /// different worker applies exactly the admission-time decoder on resume.
    Yao {
        ty: crate::yao::Type,
        definitions: BTreeMap<String, crate::yao::TypeDefinition>,
        span: crate::yao::SourceSpan,
    },
}

impl InferResultKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Json => "json",
            Self::Yao { .. } => "yao",
        }
    }
}

/// Runtime's typed, serializable representation of one Yao program.
///
/// It deliberately contains no tool implementation or Future.  A later
/// Scheduler integration can persist this tree together with a program
/// counter, bindings and pending child work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum PlanNode {
    /// Fully typed Yao v0.1 program. Legacy Plan IR remains readable while the
    /// typed frontend and machine are introduced behind this versioned node.
    Typed {
        program: Box<crate::yao::Program>,
    },
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
        /// Optional per-node evidence tool scope. `None` inherits the outer
        /// `(requires (tools ...))` declaration; `Some([])` explicitly makes
        /// this infer node pure model computation over its supplied data.
        #[serde(default)]
        tools: Option<Vec<String>>,
        #[serde(default)]
        result: InferResultKind,
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
    /// them. A pure `infer` contributes nothing; an `infer` with an explicit
    /// `(tools ...)` scope contributes exactly those evidence tools. The model
    /// computation itself has no physical effect, while any evidence gathering
    /// still crosses the ordinary Scheduler/permission boundary.
    tools: Vec<String>,
    /// Tools declared by `(requires (tools NAME...))` inside the explicit
    /// `eval`/`infer` root.
    ///
    /// Declaration exists for the part static analysis cannot see: which
    /// tools an `infer` may gather evidence with is decided at run time. An
    /// infer node may inherit this scope or narrow it locally with `(tools
    /// ...)`; `(tools)` explicitly closes the scope. The declaration lives in
    /// the program text —
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

    pub fn typed_program(&self) -> Option<&crate::yao::Program> {
        match &self.root {
            PlanNode::Typed { program } => Some(program),
            _ => None,
        }
    }
}

/// Provenance captured when model output crosses the quarantined Program
/// Value admission boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProgramValueProvenance {
    pub parent_plan_execution_id: String,
    pub producer_evaluation_id: String,
    pub terminal_event_id: Option<String>,
    pub validation_version: String,
}

/// Runtime-admitted immutable Program Value. Source alone is never this type:
/// the validated Program, typed contracts, hash, and producer provenance must
/// travel together across persistence and restart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanProgramValue {
    pub hash: String,
    pub source: String,
    pub program: Program,
    pub output: crate::yao::Type,
    pub effects: crate::yao::EffectSet,
    pub provenance: ProgramValueProvenance,
}

const YAO_TRANSPORT_TAG: &str = "$yao";

fn encode_program_value(value: &PlanProgramValue) -> Result<JsonValue, String> {
    Ok(serde_json::json!({
        YAO_TRANSPORT_TAG: {
            "kind": "program",
            "hash": value.hash,
            "value": serde_json::to_value(value)
                .map_err(|error| format!("Program Value 序列化失败: {error}"))?,
        }
    }))
}

fn decode_program_value(value: &JsonValue) -> Result<PlanProgramValue, String> {
    let tag = value
        .get(YAO_TRANSPORT_TAG)
        .and_then(JsonValue::as_object)
        .ok_or("run operand 不是 Runtime-admitted Program Value")?;
    if tag.get("kind").and_then(JsonValue::as_str) != Some("program") {
        return Err("run operand 不是 Program Value".to_string());
    }
    let declared_hash = tag
        .get("hash")
        .and_then(JsonValue::as_str)
        .ok_or("Program Value 缺少 content hash")?;
    let admitted: PlanProgramValue = serde_json::from_value(
        tag.get("value")
            .cloned()
            .ok_or("Program Value 缺少 admitted representation")?,
    )
    .map_err(|error| format!("Program Value representation 非法: {error}"))?;
    let typed = admitted
        .program
        .typed_program()
        .ok_or("Program Value 未携带 typed Yao Program")?;
    let computed_hash = crate::yao::program_hash(typed);
    if declared_hash != admitted.hash
        || admitted.hash != typed.source_hash
        || admitted.hash != computed_hash
        || admitted.output != typed.output
        || admitted.effects != typed.effects
    {
        return Err("Program Value content hash 或 typed contract 校验失败".to_string());
    }
    Ok(admitted)
}

/// Converts quarantined model output into a non-forgeable Program Value.
/// Validation uses the declared Program effect ceiling as a Tool gate and then
/// verifies the complete typed output/effect contract before encoding it.
pub fn admit_program_value_candidate(
    expected_output: &crate::yao::Type,
    expected_effects: &crate::yao::EffectSet,
    value: JsonValue,
    registry: &Registry,
    provenance: ProgramValueProvenance,
) -> Result<JsonValue, String> {
    let source = match value {
        JsonValue::String(source) => source,
        JsonValue::Object(mut object) => object
            .remove("source")
            .and_then(|value| value.as_str().map(str::to_string))
            .ok_or("Program candidate 必须是 Yao 源码字符串或 {\"source\": ...}")?,
        _ => return Err("Program candidate 必须是 Yao 源码字符串或 {\"source\": ...}".into()),
    };
    require_explicit_program_value_version(&source)?;
    let allowed_tools = expected_effects.iter().filter_map(|effect| match effect {
        crate::yao::Effect::Tool(name) => Some(name.clone()),
        _ => None,
    });
    let gate = AllowList::new(allowed_tools);
    let program = validate_typed(&source, registry, &gate).map_err(|error| error.message)?;
    if program.owner() != EvaluationOwner::Runtime {
        return Err("Program Value candidate 必须以 (eval ...) 为根".to_string());
    }
    let typed = program
        .typed_program()
        .ok_or("Program Value candidate 没有生成 typed Yao Program")?;
    if !typed.output.is_assignable_to(expected_output) {
        return Err(format!(
            "Program Value 输出 {:?} 不能赋给声明的 {:?}",
            typed.output, expected_output
        ));
    }
    if !typed.effects.is_subset(expected_effects) {
        return Err(format!(
            "Program Value effects {:?} 超过声明上限 {:?}",
            typed.effects, expected_effects
        ));
    }
    let hash = typed.source_hash.clone();
    let output = typed.output.clone();
    let effects = typed.effects.clone();
    let admitted = PlanProgramValue {
        hash,
        source,
        program,
        output,
        effects,
        provenance,
    };
    encode_program_value(&admitted)
}

fn require_explicit_program_value_version(source: &str) -> Result<(), String> {
    let root = crate::yao::parse_one(source, crate::yao::ParseLimits::default())
        .map_err(|error| format!("Program candidate 解析失败: {error}"))?;
    let crate::yao::Expr::List { items, .. } = root else {
        return Err("Program candidate 必须有 (eval ...) 根".to_string());
    };
    let explicit = items.iter().skip(1).any(|item| {
        matches!(item, crate::yao::Expr::List { items, .. }
            if items.first().and_then(crate::yao::Expr::as_symbol) == Some("version"))
    });
    if explicit {
        Ok(())
    } else {
        Err("Program Value candidate 必须显式声明 (version \"0.1\")".to_string())
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
    if source_requests_typed_semantics(source)? {
        return validate_typed(source, registry, gate);
    }
    let forms = parse_source_forms(source)?;
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

fn validate_typed(
    source: &str,
    registry: &Registry,
    gate: &dyn ToolGate,
) -> Result<Program, EvalError> {
    let profile = MorphzAnalysisProfile { registry, gate };
    let typed = crate::yao::analyze(source, &profile, crate::yao::AnalysisLimits::default())
        .map_err(|diagnostic| EvalError {
            message: format!("Yao typed admission 失败: {diagnostic}"),
            diagnostic: Some(Box::new(diagnostic)),
        })?;
    let owner = match typed.owner {
        crate::yao::EvaluationOwner::Runtime => EvaluationOwner::Runtime,
        crate::yao::EvaluationOwner::Model => EvaluationOwner::Model,
    };
    let declared = typed
        .requirements
        .tools
        .as_ref()
        .map(|tools| tools.iter().cloned().collect::<Vec<_>>());
    let tools = typed
        .effects
        .iter()
        .filter_map(|effect| match effect {
            crate::yao::Effect::Tool(name) => Some(name.clone()),
            _ => None,
        })
        .collect();
    Ok(Program {
        owner,
        root: PlanNode::Typed {
            program: Box::new(typed),
        },
        tools,
        declared,
    })
}

fn source_requests_typed_semantics(source: &str) -> Result<bool, EvalError> {
    let root = crate::yao::parse_one(source, crate::yao::ParseLimits::default()).map_err(
        |diagnostic| EvalError {
            message: format!("program 不是合法的 Yao 源码: {diagnostic}"),
            diagnostic: Some(Box::new(diagnostic)),
        },
    )?;
    let items = root
        .as_list()
        .ok_or_else(|| EvalError::from("program root 必须是显式 eval 或 infer".to_string()))?;
    // Morphz used S-expression eval programs before typed Yao v0.1. Their
    // arbitrary call/infer argument names can legitimately be `evidence`,
    // `get`, `record`, and so on, so scanning nested lists for new operator
    // names is not a sound language-version discriminator. The explicit root
    // declaration is the only ambiguity-free opt-in boundary.
    Ok(items.get(1).is_some_and(|candidate| {
        candidate
            .as_list()
            .and_then(|declaration| declaration.first())
            .and_then(crate::yao::Expr::as_symbol)
            == Some("version")
    }))
}

struct MorphzAnalysisProfile<'a> {
    registry: &'a Registry,
    gate: &'a dyn ToolGate,
}

impl crate::yao::AnalysisProfile for MorphzAnalysisProfile<'_> {
    fn tool_signature(&self, name: &str) -> Option<crate::yao::ToolSignature> {
        if !self.gate.is_callable(name) {
            return None;
        }
        let definition = self.registry.get(name)?.definition();
        Some(tool_signature_from_json_schema(&definition.parameters))
    }

    fn implicit_binding(&self, name: &str) -> Option<crate::yao::Type> {
        (name == "runtime").then(runtime_environment_type)
    }

    fn host_signature(&self, name: &str) -> Option<crate::yao::ToolSignature> {
        use crate::yao::Type;
        let signature = match name {
            "evidence.commit" => crate::yao::ToolSignature {
                arguments: BTreeMap::from([("candidate".into(), Type::EvidenceCandidate)]),
                required: BTreeSet::from(["candidate".into()]),
                result: Type::Ref("Evidence".into()),
            },
            "outcome.commit" => crate::yao::ToolSignature {
                arguments: BTreeMap::from([("candidate".into(), Type::OutcomeCandidate)]),
                required: BTreeSet::from(["candidate".into()]),
                result: Type::Ref("Outcome".into()),
            },
            "objective.report" => crate::yao::ToolSignature {
                arguments: BTreeMap::from([
                    ("objective".into(), Type::Ref("Objective".into())),
                    ("progress".into(), Type::Json),
                    (
                        "evidence".into(),
                        Type::List(Box::new(Type::Ref("Evidence".into()))),
                    ),
                ]),
                required: BTreeSet::from(["objective".into(), "progress".into()]),
                result: Type::Nil,
            },
            "objective.propose-wait" => crate::yao::ToolSignature {
                arguments: BTreeMap::from([
                    ("objective".into(), Type::Ref("Objective".into())),
                    ("condition".into(), Type::Json),
                    ("reason".into(), Type::String),
                ]),
                required: BTreeSet::from(["objective".into(), "condition".into(), "reason".into()]),
                result: Type::Nil,
            },
            "objective.propose-completion" => crate::yao::ToolSignature {
                arguments: BTreeMap::from([
                    ("objective".into(), Type::Ref("Objective".into())),
                    ("outcome".into(), Type::Ref("Outcome".into())),
                ]),
                required: BTreeSet::from(["objective".into(), "outcome".into()]),
                result: Type::Nil,
            },
            "context.propose" => crate::yao::ToolSignature {
                arguments: BTreeMap::from([("transaction".into(), Type::Json)]),
                required: BTreeSet::from(["transaction".into()]),
                result: Type::Json,
            },
            _ => return None,
        };
        Some(signature)
    }
}

fn tool_signature_from_json_schema(schema: &JsonValue) -> crate::yao::ToolSignature {
    let arguments = schema
        .get("properties")
        .and_then(JsonValue::as_object)
        .map(|properties| {
            properties
                .iter()
                .map(|(name, schema)| (name.clone(), yao_type_from_json_schema(schema)))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    let required = schema
        .get("required")
        .and_then(JsonValue::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(JsonValue::as_str)
                .map(str::to_string)
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    crate::yao::ToolSignature {
        arguments,
        required,
        // Morphz Tools currently publish JSON input schemas and return a
        // transport observation. Narrower results enter typed flow through
        // explicit `(decode TYPE ...)` until output schemas are published.
        result: crate::yao::Type::Json,
    }
}

fn yao_type_from_json_schema(schema: &JsonValue) -> crate::yao::Type {
    match schema.get("type").and_then(JsonValue::as_str) {
        Some("null") => crate::yao::Type::Nil,
        Some("boolean") => crate::yao::Type::Bool,
        Some("integer") => crate::yao::Type::Int,
        Some("number") => crate::yao::Type::Float,
        Some("string") => crate::yao::Type::String,
        Some("array") => crate::yao::Type::List(Box::new(
            schema
                .get("items")
                .map(yao_type_from_json_schema)
                .unwrap_or(crate::yao::Type::Json),
        )),
        Some("object") => crate::yao::Type::Map(Box::new(crate::yao::Type::Json)),
        _ => crate::yao::Type::Json,
    }
}

fn runtime_environment_type() -> crate::yao::Type {
    crate::yao::Type::StructuralRecord(BTreeMap::from([
        ("agent".to_string(), crate::yao::Type::Ref("Agent".into())),
        (
            "evaluation".to_string(),
            crate::yao::Type::Ref("Evaluation".into()),
        ),
        (
            "context".to_string(),
            crate::yao::Type::Ref("Context".into()),
        ),
        (
            "objective".to_string(),
            crate::yao::Type::Option(Box::new(crate::yao::Type::Ref("Objective".into()))),
        ),
        (
            "harness".to_string(),
            crate::yao::Type::Option(Box::new(crate::yao::Type::Ref("HarnessBinding".into()))),
        ),
        (
            "capabilities".to_string(),
            crate::yao::Type::Ref("CapabilitySet".into()),
        ),
        (
            "principal".to_string(),
            crate::yao::Type::Option(Box::new(crate::yao::Type::Ref("Principal".into()))),
        ),
        (
            "execution_target".to_string(),
            crate::yao::Type::Option(Box::new(crate::yao::Type::Ref("ExecutionTarget".into()))),
        ),
    ]))
}

/// Parses only the stable program envelope.
///
/// Harness loading can use this without a live tool registry. Full operator,
/// schema and deployment-gate validation still happens before activation.
pub fn inspect_program_source(source: &str) -> Result<ProgramHeader, EvalError> {
    let forms = parse_source_forms(source)?;
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
            let data_arguments = args
                .iter()
                .filter(|argument| argument_name(argument) != Some("tools"))
                .cloned()
                .collect::<Vec<_>>();
            check_pair_arguments("infer", &data_arguments, scope)?;
            let has_task = args.iter().any(|argument| {
                matches!(argument, SExpr::List(items)
                    if items.first() == Some(&SExpr::Atom("task".to_string())))
            });
            if !has_task {
                return err("(infer ...) 必须给出 (task ...) 说明要判断什么".to_string());
            }
            if let Some(tools) = infer_tool_names(args)? {
                for tool in tools {
                    if !gate.is_callable(&tool) {
                        return err(gate.describe_refusal(&tool));
                    }
                    if registry.get(&tool).is_none() {
                        return err(format!("infer 声明的工具 '{tool}' 不存在"));
                    }
                    if !facts.tools.iter().any(|seen| seen == &tool) {
                        facts.tools.push(tool);
                    }
                }
            }
            infer_result_kind(args)?;
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

fn argument_name(expr: &SExpr) -> Option<&str> {
    let SExpr::List(items) = expr else {
        return None;
    };
    let Some(SExpr::Atom(name)) = items.first() else {
        return None;
    };
    Some(name)
}

fn infer_result_kind(args: &[SExpr]) -> Result<InferResultKind, EvalError> {
    let declarations = args
        .iter()
        .filter(|argument| argument_name(argument) == Some("returns"))
        .collect::<Vec<_>>();
    if declarations.len() > 1 {
        return err("(infer ...) 重复指定了参数 '(returns ...)'".to_string());
    }
    let Some(returns) = declarations.first().copied() else {
        return Ok(InferResultKind::Text);
    };
    let SExpr::List(items) = returns else {
        unreachable!("argument_name accepted only a list")
    };
    let [SExpr::Atom(_), SExpr::Atom(kind)] = items.as_slice() else {
        return err("(returns text|json) 必须且只能给出一个静态结果类型".to_string());
    };
    match kind.as_str() {
        "text" => Ok(InferResultKind::Text),
        "json" => Ok(InferResultKind::Json),
        other => err(format!(
            "未知 infer 结果类型 '{other}'；当前只支持 text 或 json"
        )),
    }
}

fn infer_tool_names(args: &[SExpr]) -> Result<Option<Vec<String>>, EvalError> {
    let declarations = args
        .iter()
        .filter(|argument| argument_name(argument) == Some("tools"))
        .collect::<Vec<_>>();
    if declarations.len() > 1 {
        return err("(infer ...) 重复指定了参数 '(tools ...)'".to_string());
    }
    let Some(tools) = declarations.first().copied() else {
        return Ok(None);
    };
    let SExpr::List(items) = tools else {
        unreachable!("argument_name accepted only a list")
    };
    let mut names = Vec::new();
    for item in &items[1..] {
        let SExpr::Atom(name) = item else {
            return err("(tools ...) 只接受静态工具名原子".to_string());
        };
        if name.starts_with('$') {
            return err("(tools ...) 不接受动态绑定引用".to_string());
        }
        if names.iter().any(|seen| seen == name) {
            return err(format!("(tools ...) 重复声明工具 '{name}'"));
        }
        names.push(name.clone());
    }
    Ok(Some(names))
}

fn lower_infer_arguments(args: &[SExpr]) -> Result<Vec<PlanArgument>, EvalError> {
    let data_arguments = args
        .iter()
        .filter(|argument| !matches!(argument_name(argument), Some("returns") | Some("tools")))
        .cloned()
        .collect::<Vec<_>>();
    lower_arguments(&data_arguments)
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
            arguments: lower_infer_arguments(args)?,
            tools: infer_tool_names(args)?,
            result: infer_result_kind(args)?,
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
        #[serde(default)]
        result: InferResultKind,
    },
    Parallel {
        sequence: u64,
        branches: Vec<PlanParallelBranch>,
    },
    Program {
        sequence: u64,
        value: Box<PlanProgramValue>,
        machine: Box<PlanMachine>,
    },
    Host {
        sequence: u64,
        operation: String,
        arguments: JsonMap<String, JsonValue>,
        result: InferResultKind,
    },
}

/// One lexically scoped child of a typed `par` expression. Both the validated
/// Program and its initialized machine are persisted in the parent intent so
/// branch materialization is deterministic after any crash window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanParallelBranch {
    pub name: String,
    pub program: Program,
    pub machine: PlanMachine,
}

impl PlanEffect {
    pub fn sequence(&self) -> u64 {
        match self {
            Self::Call { sequence, .. }
            | Self::Infer { sequence, .. }
            | Self::Parallel { sequence, .. }
            | Self::Program { sequence, .. }
            | Self::Host { sequence, .. } => *sequence,
        }
    }

    fn failure(&self, message: impl std::fmt::Display) -> String {
        match self {
            Self::Call { tool, .. } => format!("(call {tool} ...) 失败: {message}"),
            Self::Infer { .. } => format!("(infer ...) 失败: {message}"),
            Self::Parallel { .. } => format!("(par ...) 失败: {message}"),
            Self::Program { .. } => format!("(run ...) 失败: {message}"),
            Self::Host { operation, .. } => {
                format!("host operation '{operation}' 失败: {message}")
            }
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
    #[serde(default = "default_programs_left")]
    programs_left: usize,
}

const fn default_programs_left() -> usize {
    MAX_PROGRAM_VALUE_NESTING
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
    TypedEval {
        expression: crate::yao::HirExpr,
    },
    TypedSeq {
        steps: Vec<crate::yao::HirExpr>,
        next: usize,
    },
    TypedBind {
        name: String,
    },
    TypedFallbackPrimary {
        backup: crate::yao::HirExpr,
        saved_env: HashMap<String, JsonValue>,
    },
    TypedMapItem {
        items: Vec<JsonValue>,
        next: usize,
        element: String,
        body: crate::yao::HirExpr,
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
    /// Named type definitions are part of the validated artifact and must be
    /// present after restart for `decode`, `match`, and typed infer results.
    #[serde(default)]
    typed_definitions: BTreeMap<String, crate::yao::TypeDefinition>,
}

impl PlanMachine {
    pub fn new(program: &Program) -> Result<Self, EvalError> {
        if program.owner != EvaluationOwner::Runtime {
            return err(
                "(infer ...) 是模型持有控制权的程序，必须创建正式 Evaluation，不能交给 Runtime Plan Executor"
                    .to_string(),
            );
        }
        let typed_definitions = match &program.root {
            PlanNode::Typed { program } => program.types.clone(),
            _ => BTreeMap::new(),
        };
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
                programs_left: MAX_PROGRAM_VALUE_NESTING,
            },
            next_effect_sequence: 1,
            typed_definitions,
        })
    }

    pub fn pending_effect(&self) -> Option<&PlanEffect> {
        self.pending.as_ref()
    }

    /// Installs the non-forgeable, Evaluation-bound Runtime snapshot before a
    /// root machine is persisted. Rebinding is rejected so a resumed Plan
    /// cannot silently change authority or causal identity.
    pub fn bind_runtime_environment(&mut self, value: JsonValue) -> Result<(), EvalError> {
        if self.env.contains_key("runtime") {
            return err("Plan Machine 的 runtime 环境已经绑定".to_string());
        }
        let span = crate::yao::SourceSpan::empty(crate::yao::SourceLocation::start());
        let value = crate::yao::decode_value(
            &runtime_environment_type(),
            value,
            &self.typed_definitions,
            span,
        )
        .map_err(|error| EvalError::from(format!("runtime 环境不满足 Profile 类型: {error}")))?;
        self.env.insert("runtime".to_string(), value);
        Ok(())
    }

    fn runtime_environment(&self) -> Option<JsonValue> {
        self.env.get("runtime").cloned()
    }

    pub fn runtime_reference_id(&self, field: &str) -> Option<String> {
        let runtime = self.env.get("runtime")?;
        let value = crate::yao::structural_record_field(runtime, field)?;
        crate::yao::reference_view(value).map(|(_, id)| id.to_string())
    }

    fn typed_parallel_branch(
        &self,
        name: String,
        body: crate::yao::HirExpr,
        budget: PlanBudget,
    ) -> PlanParallelBranch {
        let encoded = serde_json::to_vec(&body).unwrap_or_default();
        let source_hash = format!("sha256:{:x}", Sha256::digest(&encoded));
        let requirements = crate::yao::sema::Requirements {
            tools: self
                .declared_tools
                .as_ref()
                .map(|tools| tools.iter().cloned().collect()),
            effects: Some(body.effects.clone()),
            objects: None,
        };
        let typed = crate::yao::Program {
            language_version: "0.1".to_string(),
            owner: crate::yao::EvaluationOwner::Runtime,
            requirements,
            types: self.typed_definitions.clone(),
            output: body.ty.clone(),
            effects: body.effects.clone(),
            body: body.clone(),
            canonical_source: format!("(generated-par-branch {name} {source_hash})"),
            source_hash,
        };
        let tools = body
            .effects
            .iter()
            .filter_map(|effect| match effect {
                crate::yao::Effect::Tool(tool) => Some(tool.clone()),
                _ => None,
            })
            .collect();
        let program = Program {
            owner: EvaluationOwner::Runtime,
            root: PlanNode::Typed {
                program: Box::new(typed),
            },
            tools,
            declared: self.declared_tools.clone(),
        };
        let machine = Self {
            frames: vec![MachineFrame::TypedEval { expression: body }],
            env: self.env.clone(),
            signal: None,
            pending: None,
            terminal: None,
            declared_tools: self.declared_tools.clone(),
            budget,
            next_effect_sequence: 1,
            typed_definitions: self.typed_definitions.clone(),
        };
        PlanParallelBranch {
            name,
            program,
            machine,
        }
    }

    /// Highest effect sequence that may already have produced an external
    /// artifact while recovering data written by an older Runtime.
    ///
    /// Normally `next_effect_sequence - 1` is the last issued effect.  The
    /// ceiling deliberately includes `next_effect_sequence`: older builds
    /// could persist a tool output before the Plan state checkpoint failed
    /// with SQLITE_BUSY, leaving the durable machine one sequence behind.
    pub fn effect_sequence_recovery_ceiling(&self) -> u64 {
        self.next_effect_sequence.max(1)
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
                        PlanNode::Typed { program } => {
                            self.typed_definitions = program.types.clone();
                            self.frames.push(MachineFrame::TypedEval {
                                expression: program.body,
                            });
                        }
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
                        PlanNode::Infer {
                            arguments,
                            tools,
                            result,
                        } => {
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
                                        tools: tools.or_else(|| self.declared_tools.clone()),
                                        result,
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
                MachineFrame::TypedEval { expression } => {
                    if self.signal.is_some() {
                        return self.fail_internal("Plan Machine 在已有结果时仍尝试求值 typed HIR");
                    }
                    if let Some(advance) = self.advance_typed(expression, registry) {
                        return advance;
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
                MachineFrame::TypedSeq { steps, next } => {
                    let Some(signal) = self.signal.take() else {
                        return self.fail_internal("typed seq continuation 缺少前一步结果");
                    };
                    match signal {
                        failure @ MachineSignal::Failure { .. } => self.signal = Some(failure),
                        value @ MachineSignal::Value { .. } if next >= steps.len() => {
                            self.signal = Some(value);
                        }
                        MachineSignal::Value { .. } => {
                            let expression = steps[next].clone();
                            self.frames.push(MachineFrame::TypedSeq {
                                steps,
                                next: next + 1,
                            });
                            self.frames.push(MachineFrame::TypedEval { expression });
                        }
                    }
                }
                MachineFrame::TypedBind { name } => {
                    let Some(signal) = self.signal.take() else {
                        return self.fail_internal("typed bind continuation 缺少被绑定值");
                    };
                    match signal {
                        MachineSignal::Value { value } => {
                            if self.env.insert(name.clone(), value).is_some() {
                                self.raise(EvalError::from(format!(
                                    "typed binding '{name}' 试图覆盖已有绑定"
                                )));
                            } else {
                                self.signal = Some(MachineSignal::Value {
                                    value: JsonValue::Null,
                                });
                            }
                        }
                        failure @ MachineSignal::Failure { .. } => self.signal = Some(failure),
                    }
                }
                MachineFrame::TypedFallbackPrimary { backup, saved_env } => {
                    let Some(signal) = self.signal.take() else {
                        return self.fail_internal("typed fallback primary 缺少结果");
                    };
                    self.env = saved_env.clone();
                    match signal {
                        value @ MachineSignal::Value { .. } => self.signal = Some(value),
                        MachineSignal::Failure { .. } => {
                            self.frames.push(MachineFrame::RestoreScope { saved_env });
                            self.frames
                                .push(MachineFrame::TypedEval { expression: backup });
                        }
                    }
                }
                MachineFrame::TypedMapItem {
                    items,
                    next,
                    element,
                    body,
                    mut results,
                    saved_env,
                } => {
                    let Some(signal) = self.signal.take() else {
                        return self.fail_internal("typed map body 缺少结果");
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
                                self.frames.push(MachineFrame::TypedMapItem {
                                    items,
                                    next: next + 1,
                                    element,
                                    body: body.clone(),
                                    results,
                                    saved_env,
                                });
                                self.frames
                                    .push(MachineFrame::TypedEval { expression: body });
                            }
                        }
                    }
                }
            }
        }
    }

    /// Advances one typed HIR node. `None` means control returned to the
    /// deterministic frame loop; `Some` is a suspension or terminal integrity
    /// failure that must be returned immediately.
    fn advance_typed(
        &mut self,
        expression: crate::yao::HirExpr,
        registry: &Registry,
    ) -> Option<PlanAdvance> {
        if expression.effects.is_empty() {
            match crate::yao::evaluate_pure(&expression, &mut self.env, &self.typed_definitions) {
                Ok(value) => self.signal = Some(MachineSignal::Value { value }),
                Err(error) => self.raise(EvalError::from(format!("Yao value failure: {error}"))),
            }
            return None;
        }

        let span = expression.span;
        match expression.kind {
            crate::yao::HirKind::Seq { steps } => {
                let Some(first) = steps.first().cloned() else {
                    self.raise(EvalError::from("typed HIR seq 不应为空".to_string()));
                    return None;
                };
                self.frames.push(MachineFrame::TypedSeq { steps, next: 1 });
                self.frames
                    .push(MachineFrame::TypedEval { expression: first });
            }
            crate::yao::HirKind::Bind { name, value } => {
                self.frames.push(MachineFrame::TypedBind { name });
                self.frames
                    .push(MachineFrame::TypedEval { expression: *value });
            }
            crate::yao::HirKind::If {
                condition,
                when_true,
                when_false,
            } => {
                match crate::yao::evaluate_pure(&condition, &mut self.env, &self.typed_definitions)
                {
                    Ok(JsonValue::Bool(value)) => {
                        let selected = if value { *when_true } else { *when_false };
                        self.frames.push(MachineFrame::RestoreScope {
                            saved_env: self.env.clone(),
                        });
                        self.frames.push(MachineFrame::TypedEval {
                            expression: selected,
                        });
                    }
                    Ok(_) => self.raise(EvalError::from(
                        "typed if condition 在运行时不是 Bool".to_string(),
                    )),
                    Err(error) => {
                        self.raise(EvalError::from(format!("Yao value failure: {error}")))
                    }
                }
            }
            crate::yao::HirKind::Match { value, cases } => {
                match crate::yao::evaluate_pure(&value, &mut self.env, &self.typed_definitions) {
                    Ok(value) => {
                        let Some((variant, fields)) = crate::yao::variant_view(&value) else {
                            self.raise(EvalError::from(
                                "typed match value 不是 Yao union variant".to_string(),
                            ));
                            return None;
                        };
                        let Some(case) = cases.into_iter().find(|case| case.variant == variant)
                        else {
                            self.raise(EvalError::from(format!(
                                "typed match 没有 variant '{variant}' 的分支"
                            )));
                            return None;
                        };
                        let saved_env = self.env.clone();
                        for binding in case.bindings {
                            let Some(value) = fields.get(&binding.field).cloned() else {
                                self.raise(EvalError::from(format!(
                                    "variant '{variant}' 缺少字段 '{}'",
                                    binding.field
                                )));
                                return None;
                            };
                            self.env.insert(binding.binding, value);
                        }
                        self.frames.push(MachineFrame::RestoreScope { saved_env });
                        self.frames.push(MachineFrame::TypedEval {
                            expression: case.body,
                        });
                    }
                    Err(error) => {
                        self.raise(EvalError::from(format!("Yao value failure: {error}")))
                    }
                }
            }
            crate::yao::HirKind::Fallback { primary, backup } => {
                self.frames.push(MachineFrame::TypedFallbackPrimary {
                    backup: *backup,
                    saved_env: self.env.clone(),
                });
                self.frames.push(MachineFrame::TypedEval {
                    expression: *primary,
                });
            }
            crate::yao::HirKind::Map {
                collection,
                element,
                body,
            } => {
                match crate::yao::evaluate_pure(&collection, &mut self.env, &self.typed_definitions)
                {
                    Ok(JsonValue::Array(items)) if items.len() <= MAX_MAP_ELEMENTS => {
                        if items.is_empty() {
                            self.signal = Some(MachineSignal::Value {
                                value: JsonValue::Array(Vec::new()),
                            });
                        } else {
                            let saved_env = self.env.clone();
                            self.env.insert(element.clone(), items[0].clone());
                            self.frames.push(MachineFrame::TypedMapItem {
                                items,
                                next: 1,
                                element,
                                body: *body.clone(),
                                results: Vec::new(),
                                saved_env,
                            });
                            self.frames
                                .push(MachineFrame::TypedEval { expression: *body });
                        }
                    }
                    Ok(JsonValue::Array(items)) => self.raise(EvalError::from(format!(
                        "typed map 集合有 {} 个元素，超过上限 {MAX_MAP_ELEMENTS}",
                        items.len()
                    ))),
                    Ok(_) => self.raise(EvalError::from(
                        "typed map collection 在运行时不是 List".to_string(),
                    )),
                    Err(error) => {
                        self.raise(EvalError::from(format!("Yao value failure: {error}")))
                    }
                }
            }
            crate::yao::HirKind::Call { tool, arguments } => {
                if self.budget.calls_left == 0 {
                    self.raise(EvalError::from(format!(
                        "程序的工具调用次数超过上限 {MAX_PROGRAM_CALLS}"
                    )));
                    return None;
                }
                if registry.get(&tool).is_none() {
                    self.raise(EvalError::from(format!("工具 '{tool}' 不存在")));
                    return None;
                }
                match build_typed_arguments(&arguments, &mut self.env, &self.typed_definitions) {
                    Ok(arguments) => {
                        self.budget.calls_left -= 1;
                        let effect = PlanEffect::Call {
                            sequence: self.take_effect_sequence(),
                            tool,
                            arguments,
                        };
                        self.pending = Some(effect.clone());
                        return Some(PlanAdvance::Suspended(effect));
                    }
                    Err(error) => self.raise(error),
                }
            }
            crate::yao::HirKind::Infer {
                arguments,
                tools,
                result,
            } => {
                if self.budget.infers_left == 0 {
                    self.raise(EvalError::from(format!(
                        "程序的 infer 次数超过上限 {MAX_PROGRAM_INFERS}"
                    )));
                    return None;
                }
                match build_typed_arguments(&arguments, &mut self.env, &self.typed_definitions) {
                    Ok(request) => {
                        self.budget.infers_left -= 1;
                        let effect = PlanEffect::Infer {
                            sequence: self.take_effect_sequence(),
                            request,
                            tools: tools.or_else(|| self.declared_tools.clone()),
                            result: InferResultKind::Yao {
                                ty: result,
                                definitions: self.typed_definitions.clone(),
                                span,
                            },
                        };
                        self.pending = Some(effect.clone());
                        return Some(PlanAdvance::Suspended(effect));
                    }
                    Err(error) => self.raise(error),
                }
            }
            crate::yao::HirKind::Par { branches } => {
                let tool_branch_count = branches
                    .iter()
                    .filter(|branch| {
                        branch
                            .body
                            .effects
                            .iter()
                            .any(|effect| matches!(effect, crate::yao::Effect::Tool(_)))
                    })
                    .count();
                let infer_branch_count = branches
                    .iter()
                    .filter(|branch| branch.body.effects.contains(&crate::yao::Effect::Infer))
                    .count();
                let program_branch_count = branches
                    .iter()
                    .filter(|branch| {
                        branch
                            .body
                            .effects
                            .iter()
                            .any(|effect| matches!(effect, crate::yao::Effect::Program(_)))
                    })
                    .count();
                let calls_per_branch = self
                    .budget
                    .calls_left
                    .checked_div(tool_branch_count)
                    .unwrap_or(0);
                let infers_per_branch = self
                    .budget
                    .infers_left
                    .checked_div(infer_branch_count)
                    .unwrap_or(0);
                let programs_per_branch = self
                    .budget
                    .programs_left
                    .checked_div(program_branch_count)
                    .unwrap_or(0);
                self.budget.calls_left = self
                    .budget
                    .calls_left
                    .saturating_sub(calls_per_branch.saturating_mul(tool_branch_count));
                self.budget.infers_left = self
                    .budget
                    .infers_left
                    .saturating_sub(infers_per_branch.saturating_mul(infer_branch_count));
                self.budget.programs_left = self
                    .budget
                    .programs_left
                    .saturating_sub(programs_per_branch.saturating_mul(program_branch_count));
                let children = branches
                    .into_iter()
                    .map(|branch| {
                        let budget = PlanBudget {
                            calls_left: if branch
                                .body
                                .effects
                                .iter()
                                .any(|effect| matches!(effect, crate::yao::Effect::Tool(_)))
                            {
                                calls_per_branch
                            } else {
                                0
                            },
                            infers_left: if branch.body.effects.contains(&crate::yao::Effect::Infer)
                            {
                                infers_per_branch
                            } else {
                                0
                            },
                            programs_left: if branch
                                .body
                                .effects
                                .iter()
                                .any(|effect| matches!(effect, crate::yao::Effect::Program(_)))
                            {
                                programs_per_branch
                            } else {
                                0
                            },
                        };
                        self.typed_parallel_branch(branch.name, branch.body, budget)
                    })
                    .collect::<Vec<_>>();
                let effect = PlanEffect::Parallel {
                    sequence: self.take_effect_sequence(),
                    branches: children,
                };
                self.pending = Some(effect.clone());
                return Some(PlanAdvance::Suspended(effect));
            }
            crate::yao::HirKind::Run { program } => {
                if self.budget.programs_left == 0 {
                    self.raise(EvalError::from(format!(
                        "Program Value 嵌套超过上限 {MAX_PROGRAM_VALUE_NESTING}"
                    )));
                    return None;
                }
                match crate::yao::evaluate_pure(&program, &mut self.env, &self.typed_definitions)
                    .map_err(|error| format!("Yao value failure: {error}"))
                    .and_then(|value| decode_program_value(&value))
                {
                    Ok(value) => {
                        self.budget.programs_left -= 1;
                        let mut child = match PlanMachine::new(&value.program) {
                            Ok(machine) => machine,
                            Err(error) => {
                                self.raise(error);
                                return None;
                            }
                        };
                        // Program Values are isolated from caller-local bindings,
                        // but inherit the same immutable Runtime authority snapshot.
                        if let Some(runtime) = self.runtime_environment() {
                            if let Err(error) = child.bind_runtime_environment(runtime) {
                                self.raise(error);
                                return None;
                            }
                        }
                        // Transfer the remaining aggregate ceilings to the
                        // child. v0.1 deliberately does not refund unused
                        // child budget after join; this is conservative and
                        // restart-stable.
                        child.budget = self.budget.clone();
                        self.budget.calls_left = 0;
                        self.budget.infers_left = 0;
                        self.budget.programs_left = 0;
                        let effect = PlanEffect::Program {
                            sequence: self.take_effect_sequence(),
                            value: Box::new(value),
                            machine: Box::new(child),
                        };
                        self.pending = Some(effect.clone());
                        return Some(PlanAdvance::Suspended(effect));
                    }
                    Err(error) => self.raise(EvalError::from(error)),
                }
            }
            crate::yao::HirKind::Host {
                operation,
                arguments,
            } => match build_typed_arguments(&arguments, &mut self.env, &self.typed_definitions) {
                Ok(arguments) => {
                    let effect = PlanEffect::Host {
                        sequence: self.take_effect_sequence(),
                        operation,
                        arguments,
                        result: InferResultKind::Yao {
                            ty: expression.ty,
                            definitions: self.typed_definitions.clone(),
                            span,
                        },
                    };
                    self.pending = Some(effect.clone());
                    return Some(PlanAdvance::Suspended(effect));
                }
                Err(error) => self.raise(error),
            },
            _ => self.raise(EvalError::from(
                "effectful 标记出现在不允许产生 effect 的 typed HIR 节点".to_string(),
            )),
        }
        None
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
    evaluate_machine(PlanMachine::new(program)?, registry, host).await
}

async fn evaluate_machine(
    mut machine: PlanMachine,
    registry: Arc<Registry>,
    host: Arc<dyn RuntimeInference>,
) -> Result<JsonValue, EvalError> {
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
                    PlanEffect::Infer {
                        request,
                        tools,
                        result,
                        ..
                    } => match host.infer(&request, tools.as_deref()).await {
                        Ok(value) => decode_infer_result_with_admission(
                            result,
                            JsonValue::String(value),
                            &registry,
                            ProgramValueProvenance {
                                parent_plan_execution_id: "in-process".to_string(),
                                producer_evaluation_id: "in-process".to_string(),
                                terminal_event_id: None,
                                validation_version: "yao-0.1".to_string(),
                            },
                        ),
                        Err(error) => Err(error.to_string()),
                    },
                    PlanEffect::Parallel { branches, .. } => {
                        // The convenience evaluator has no durable scheduler;
                        // it preserves the same isolated branch machines and
                        // deterministic join while executing them serially.
                        // Production Morphz lowers this effect to a durable
                        // Action Group whose branches may run concurrently.
                        let mut fields = Vec::with_capacity(branches.len());
                        let mut failures = Vec::new();
                        for branch in branches {
                            match Box::pin(evaluate_machine(
                                branch.machine,
                                Arc::clone(&registry),
                                Arc::clone(&host),
                            ))
                            .await
                            {
                                Ok(value) => fields.push((branch.name, value)),
                                Err(error) => failures.push((branch.name, error.message)),
                            }
                        }
                        if failures.is_empty() {
                            Ok(crate::yao::structural_record_value(fields))
                        } else {
                            Err(failures
                                .into_iter()
                                .map(|(name, error)| format!("{name}: {error}"))
                                .collect::<Vec<_>>()
                                .join("; "))
                        }
                    }
                    PlanEffect::Program { machine: child, .. } => Box::pin(evaluate_machine(
                        *child,
                        Arc::clone(&registry),
                        Arc::clone(&host),
                    ))
                    .await
                    .map_err(|error| error.message),
                    PlanEffect::Host { operation, .. } => Err(format!(
                        "in-process convenience evaluator 没有 Morphz authority，不能执行 host operation '{operation}'"
                    )),
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

fn build_typed_arguments(
    args: &[crate::yao::sema::NamedArgument],
    env: &mut HashMap<String, JsonValue>,
    definitions: &BTreeMap<String, crate::yao::TypeDefinition>,
) -> Result<JsonMap<String, JsonValue>, EvalError> {
    let mut output = JsonMap::new();
    for argument in args {
        let mut values = argument
            .values
            .iter()
            .map(|value| {
                crate::yao::evaluate_pure(value, env, definitions)
                    .map_err(|error| EvalError::from(format!("Yao argument failure: {error}")))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let value = if values.len() == 1 {
            values.pop().expect("length checked above")
        } else {
            JsonValue::Array(values)
        };
        if output.insert(argument.name.clone(), value).is_some() {
            return err(format!("typed argument '{}' 重复", argument.name));
        }
    }
    Ok(output)
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

/// Applies the explicit result contract after a nested Evaluation completes.
///
/// No Markdown fence stripping or best-effort repair is performed: accepting
/// malformed output would make a supposedly typed Runtime program depend on a
/// heuristic parser.  A Harness can use `fallback` around the infer when it
/// wants a recovery path.
pub fn decode_infer_result(kind: InferResultKind, value: JsonValue) -> Result<JsonValue, String> {
    match kind {
        InferResultKind::Text => Ok(value),
        InferResultKind::Json => match value {
            JsonValue::String(text) => serde_json::from_str(text.trim()).map_err(|error| {
                format!("infer 声明 returns=json，但最终正文不是合法 JSON: {error}")
            }),
            structured => Ok(structured),
        },
        InferResultKind::Yao {
            ty,
            definitions,
            span,
        } => {
            if matches!(ty, crate::yao::Type::Program { .. }) {
                return Err(
                    "Program candidate 不能由普通 decoder 接纳；必须经过 Runtime admission"
                        .to_string(),
                );
            }
            let transport = match (&ty, value) {
                (crate::yao::Type::String, value @ JsonValue::String(_)) => value,
                (_, JsonValue::String(text)) => {
                    serde_json::from_str(text.trim()).map_err(|error| {
                        format!(
                        "infer 声明了 typed Yao 返回值，但最终正文不是合法 JSON transport: {error}"
                    )
                    })?
                }
                (_, structured) => structured,
            };
            crate::yao::decode_value(&ty, transport, &definitions, span)
                .map_err(|error| format!("infer 返回值不满足 Yao 类型 {ty:?}: {error}"))
        }
    }
}

pub fn decode_infer_result_with_admission(
    kind: InferResultKind,
    value: JsonValue,
    registry: &Registry,
    provenance: ProgramValueProvenance,
) -> Result<JsonValue, String> {
    match kind {
        InferResultKind::Yao {
            ty: crate::yao::Type::Program { output, effects },
            ..
        } => admit_program_value_candidate(&output, &effects, value, registry, provenance),
        other => decode_infer_result(other, value),
    }
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
            "(this deployment exposes no tools inside the tree; the program may use only structural operators and infer)".to_string()
        } else {
            format!(
                "{} (use ordinary Function Calling for all other tools)",
                callable.join(" ")
            )
        };
        format!(
            "Submit an evaluable S-expression program for deterministic Runtime execution of multiple data-dependent steps in one call.\
             Use it when the steps are known in advance and later steps consume earlier results. For a single step, or when you must inspect a result before deciding what to do next, continue using ordinary Function Calling; this tool does not replace it.\n\
             This tool accepts only an explicit (eval ...) root. Model-directed (infer ...) roots are turned into formal Evaluations by the Runtime and are not submitted to this tool.\n\
             An (eval ...) may begin with (requires (tools NAME...)) to narrow its capabilities and must then contain exactly one program body; combine multiple steps with (seq ...).\n\
             The declaration cannot exceed the tool list below. Once declared, both call and infer evidence gathering are restricted to those tools.\n\
             Callable tools: {tools}\n\
             `reply` and `process` belong to your own evaluation and are unavailable inside this program.\n\
             Operator contract:\n{contract}\n\
             Example:\n\
             (eval\n\
               (requires (tools list_files read))\n\
               (seq\n\
                 (bind files (call list_files (path \"src\")))\n\
                 (bind bodies (map $files f (call read (path $f))))\n\
                 (infer (task \"Which files contain TODO?\") (evidence $bodies))))",
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
                        "description": "A canonical Yao program with an explicit eval root, for example (eval (seq (bind files (call list_files (path \"src\"))) (map $files f (call read (path $f)))))"
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

    fn contains_cjk(text: &str) -> bool {
        text.chars().any(|character| {
            matches!(
                character,
                '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}' | '\u{f900}'..='\u{faff}'
            )
        })
    }

    #[test]
    fn model_visible_eval_language_contract_is_english_only() {
        let contract = operator_contract();
        assert!(!contains_cjk(&contract), "operator contract: {contract}");
        let description = EvalTool::description(
            &DEFAULT_CALLABLE_TOOLS
                .iter()
                .map(|tool| (*tool).to_string())
                .collect::<Vec<_>>(),
        );
        assert!(!contains_cjk(&description), "eval tool: {description}");
    }

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
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "query": {"type": "string"},
                        "input": {}
                    }
                }),
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
    async fn json_infer_results_become_addressable_plan_data() {
        let (registry, seen) = fixture(&[("search", serde_json::json!(["matched"]))]);
        let program = validate(
            r#"(eval
                 (requires (tools search))
                 (seq
                   (bind decision
                     (infer
                       (task "选择查询词")
                       (returns json)
                       (evidence "fixture")))
                   (call search (query $decision.query))))"#,
            &registry,
            &AllowList::new(["search"]),
        )
        .unwrap();
        let (inference, requests) = host(r#"{"query":"needle"}"#);
        let value = evaluate(&program, registry, inference).await.unwrap();

        assert_eq!(value, serde_json::json!(["matched"]));
        assert_eq!(
            seen.lock().unwrap().as_slice(),
            &[r#"search:{"query":"needle"}"#.to_string()]
        );
        assert_eq!(requests.lock().unwrap()[0]["task"], "选择查询词");
        assert!(requests.lock().unwrap()[0].get("returns").is_none());
    }

    #[tokio::test]
    async fn malformed_json_infer_results_are_classified_failures_for_fallback() {
        let registry = fixture(&[]).0;
        let program = validate(
            r#"(eval
                 (fallback
                   (infer (task "返回对象") (returns json))
                   "recovered"))"#,
            &registry,
            &AllowList::new(Vec::<String>::new()),
        )
        .unwrap();
        let (inference, _) = host("not-json");

        assert_eq!(
            evaluate(&program, registry, inference).await.unwrap(),
            serde_json::json!("recovered")
        );
    }

    #[test]
    fn infer_result_contract_is_static_and_known_before_execution() {
        let registry = fixture(&[]).0;
        for source in [
            r#"(eval (infer (task "x") (returns yaml)))"#,
            r#"(eval (infer (task "x") (returns json text)))"#,
            r#"(eval (infer (task "x") (returns json) (returns text)))"#,
            r#"(eval (infer (task "x") (tools) (tools search)))"#,
        ] {
            let error = validate(source, &registry, &AllowList::new(Vec::<String>::new()))
                .unwrap_err()
                .message;
            assert!(
                error.contains("returns") || error.contains("结果类型") || error.contains("tools"),
                "{error}"
            );
        }
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
        assert!(tool
            .definition()
            .description
            .contains("Callable tools: search"));

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
            description.contains("this deployment exposes no tools inside the tree"),
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

    #[tokio::test]
    async fn infer_can_explicitly_close_or_narrow_its_own_tool_scope() {
        let (registry, _) = fixture(&[
            ("read", serde_json::json!("evidence")),
            ("search", serde_json::json!([])),
        ]);
        let pure = validate(
            r#"(eval
                 (requires (tools read search))
                 (seq
                   (bind evidence (call read (path "a")))
                   (infer (task "judge") (tools) (evidence $evidence))))"#,
            &registry,
            &gate(),
        )
        .unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let offered = Arc::new(Mutex::new(Vec::new()));
        let host: Arc<dyn RuntimeInference> = Arc::new(ScriptedHost {
            answer: "ok".to_string(),
            seen,
            tools_offered: Arc::clone(&offered),
        });
        evaluate(&pure, Arc::clone(&registry), host).await.unwrap();
        assert_eq!(offered.lock().unwrap().as_slice(), &[Some(Vec::new())]);

        let narrowed = validate(
            r#"(eval
                 (requires (tools read search))
                 (infer (task "research") (tools search)))"#,
            &registry,
            &gate(),
        )
        .unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let offered = Arc::new(Mutex::new(Vec::new()));
        let host: Arc<dyn RuntimeInference> = Arc::new(ScriptedHost {
            answer: "ok".to_string(),
            seen,
            tools_offered: Arc::clone(&offered),
        });
        evaluate(&narrowed, registry, host).await.unwrap();
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
    fn explicit_root_version_is_the_only_typed_compatibility_boundary() {
        assert!(
            source_requests_typed_semantics(r#"(eval (version "0.1") (dict (answer 1)))"#).unwrap()
        );
        assert!(!source_requests_typed_semantics(
            r#"(eval (seq
                 (bind value (infer (task "legacy") (evidence "x")))
                 (call search (get $value))))"#
        )
        .unwrap());
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

    #[test]
    fn typed_pure_program_executes_through_the_same_plan_machine() {
        let registry = fixture(&[]).0;
        let program = validate(
            r#"(eval
                 (version "0.1")
                 (seq
                   (bind x (add 2 3))
                   (if (eq $x 5) (mul $x 2) 0)))"#,
            &registry,
            &AllowList::new(Vec::<String>::new()),
        )
        .unwrap();
        assert!(matches!(program.root(), PlanNode::Typed { .. }));

        let mut machine = PlanMachine::new(&program).unwrap();
        assert_eq!(
            machine.advance(&registry),
            PlanAdvance::Complete(serde_json::json!(10))
        );
    }

    #[test]
    fn typed_effects_decode_and_resume_identically_after_serialization() {
        let registry = fixture(&[("read", serde_json::json!("evidence"))]).0;
        let program = validate(
            r#"(eval
                 (version "0.1")
                 (requires (tools read))
                 (seq
                   (bind evidence (call read (path "a.txt")))
                   (bind score
                     (infer
                       (task "return an integer")
                       (returns Int)
                       (evidence (decode String $evidence))))
                   (add $score 1)))"#,
            &registry,
            &AllowList::new(["read"]),
        )
        .unwrap();
        let mut machine = PlanMachine::new(&program).unwrap();

        let call = match machine.advance(&registry) {
            PlanAdvance::Suspended(effect @ PlanEffect::Call { .. }) => effect,
            other => panic!("expected typed call, got {other:?}"),
        };
        let encoded = serde_json::to_string(&machine).unwrap();
        let mut machine: PlanMachine = serde_json::from_str(&encoded).unwrap();
        assert_eq!(machine.pending_effect(), Some(&call));
        machine
            .resume_effect(call.sequence(), Ok(serde_json::json!("evidence")))
            .unwrap();

        let inference = match machine.advance(&registry) {
            PlanAdvance::Suspended(effect @ PlanEffect::Infer { .. }) => effect,
            other => panic!("expected typed infer, got {other:?}"),
        };
        let PlanEffect::Infer { result, .. } = inference.clone() else {
            unreachable!()
        };
        assert!(matches!(
            result,
            InferResultKind::Yao {
                ty: crate::yao::Type::Int,
                ..
            }
        ));
        let decoded = decode_infer_result(result, JsonValue::String("41".to_string())).unwrap();

        let encoded = serde_json::to_string(&machine).unwrap();
        let mut machine: PlanMachine = serde_json::from_str(&encoded).unwrap();
        assert_eq!(machine.pending_effect(), Some(&inference));
        machine
            .resume_effect(inference.sequence(), Ok(decoded))
            .unwrap();
        assert_eq!(
            machine.advance(&registry),
            PlanAdvance::Complete(serde_json::json!(42))
        );
    }

    #[test]
    fn program_candidate_is_admitted_then_run_as_an_isolated_child_machine() {
        let registry = fixture(&[]).0;
        let parent = validate(
            r#"(eval
                 (version "0.1")
                 (seq
                   (bind generated
                     (infer
                       (task "produce a pure integer program")
                       (returns (Program Int (effects)))))
                   (run $generated)))"#,
            &registry,
            &AllowList::new(Vec::<String>::new()),
        )
        .unwrap();
        let mut machine = PlanMachine::new(&parent).unwrap();
        let inference = match machine.advance(&registry) {
            PlanAdvance::Suspended(effect @ PlanEffect::Infer { .. }) => effect,
            other => panic!("expected Program-producing infer, got {other:?}"),
        };
        let PlanEffect::Infer { result, .. } = inference.clone() else {
            unreachable!()
        };
        let admitted = decode_infer_result_with_admission(
            result,
            JsonValue::String(r#"(eval (version "0.1") (add 20 22))"#.to_string()),
            &registry,
            ProgramValueProvenance {
                parent_plan_execution_id: "parent-plan".into(),
                producer_evaluation_id: "child-eval".into(),
                terminal_event_id: Some("terminal-event".into()),
                validation_version: "yao-0.1".into(),
            },
        )
        .unwrap();
        assert_eq!(admitted["$yao"]["kind"], "program");
        assert!(admitted["$yao"]["hash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"));
        machine
            .resume_effect(inference.sequence(), Ok(admitted))
            .unwrap();

        let program_effect = match machine.advance(&registry) {
            PlanAdvance::Suspended(effect @ PlanEffect::Program { .. }) => effect,
            other => panic!("expected durable Program child boundary, got {other:?}"),
        };
        let encoded = serde_json::to_string(&machine).unwrap();
        let mut restored: PlanMachine = serde_json::from_str(&encoded).unwrap();
        assert_eq!(restored.pending_effect(), Some(&program_effect));
        let PlanEffect::Program {
            sequence,
            mut machine,
            ..
        } = program_effect
        else {
            unreachable!()
        };
        assert_eq!(
            machine.advance(&registry),
            PlanAdvance::Complete(serde_json::json!(42))
        );
        restored
            .resume_effect(sequence, Ok(serde_json::json!(42)))
            .unwrap();
        assert_eq!(
            restored.advance(&registry),
            PlanAdvance::Complete(serde_json::json!(42))
        );
    }

    #[test]
    fn generated_program_inherits_only_the_runtime_snapshot() {
        let registry = fixture(&[]).0;
        let parent = validate(
            r#"(eval
                 (version "0.1")
                 (seq
                   (bind caller-local "must-not-leak")
                   (bind generated
                     (infer
                       (task "produce a program that reads its Context Ref")
                       (returns (Program (Ref Context) (effects)))))
                   (run $generated)))"#,
            &registry,
            &AllowList::new(Vec::<String>::new()),
        )
        .unwrap();
        let mut machine = PlanMachine::new(&parent).unwrap();
        machine
            .bind_runtime_environment(crate::yao::structural_record_value([
                (
                    "agent".into(),
                    crate::yao::reference_value("Agent", "agent-1"),
                ),
                (
                    "evaluation".into(),
                    crate::yao::reference_value("Evaluation", "evaluation-1"),
                ),
                (
                    "context".into(),
                    crate::yao::reference_value("Context", "context-1"),
                ),
                (
                    "objective".into(),
                    crate::yao::optional_reference_value("Objective", None),
                ),
                (
                    "harness".into(),
                    crate::yao::optional_reference_value("HarnessBinding", None),
                ),
                (
                    "capabilities".into(),
                    crate::yao::reference_value("CapabilitySet", "capabilities-1"),
                ),
                (
                    "principal".into(),
                    crate::yao::optional_reference_value("Principal", None),
                ),
                (
                    "execution_target".into(),
                    crate::yao::optional_reference_value("ExecutionTarget", None),
                ),
            ]))
            .unwrap();
        let inference = match machine.advance(&registry) {
            PlanAdvance::Suspended(effect @ PlanEffect::Infer { .. }) => effect,
            other => panic!("expected Program-producing infer, got {other:?}"),
        };
        let PlanEffect::Infer { result, .. } = inference.clone() else {
            unreachable!()
        };
        let admitted = decode_infer_result_with_admission(
            result,
            JsonValue::String(r#"(eval (version "0.1") $runtime.context)"#.to_string()),
            &registry,
            ProgramValueProvenance {
                parent_plan_execution_id: "parent-plan".into(),
                producer_evaluation_id: "child-eval".into(),
                terminal_event_id: Some("terminal-event".into()),
                validation_version: "yao-0.1".into(),
            },
        )
        .unwrap();
        machine
            .resume_effect(inference.sequence(), Ok(admitted))
            .unwrap();
        let PlanEffect::Program {
            machine: mut child, ..
        } = (match machine.advance(&registry) {
            PlanAdvance::Suspended(effect @ PlanEffect::Program { .. }) => effect,
            other => panic!("expected Program child, got {other:?}"),
        })
        else {
            unreachable!()
        };
        assert!(!child.env.contains_key("caller-local"));
        assert_eq!(
            child.runtime_reference_id("context").as_deref(),
            Some("context-1")
        );
        assert_eq!(
            child.advance(&registry),
            PlanAdvance::Complete(crate::yao::reference_value("Context", "context-1"))
        );
    }

    #[test]
    fn program_admission_rejects_implicit_versions_contract_escape_and_forgery() {
        let registry = fixture(&[("read", JsonValue::Null)]).0;
        let provenance = || ProgramValueProvenance {
            parent_plan_execution_id: "parent-plan".into(),
            producer_evaluation_id: "child-eval".into(),
            terminal_event_id: None,
            validation_version: "yao-0.1".into(),
        };
        let empty = crate::yao::EffectSet::default();
        assert!(admit_program_value_candidate(
            &crate::yao::Type::Int,
            &empty,
            JsonValue::String("(eval 1)".into()),
            &registry,
            provenance(),
        )
        .unwrap_err()
        .contains("version"));
        assert!(admit_program_value_candidate(
            &crate::yao::Type::Int,
            &empty,
            JsonValue::String(r#"(eval (version "0.1") "wrong")"#.into()),
            &registry,
            provenance(),
        )
        .unwrap_err()
        .contains("不能赋给"));
        assert!(admit_program_value_candidate(
            &crate::yao::Type::Json,
            &empty,
            JsonValue::String(
                r#"(eval (version "0.1") (requires (tools read)) (call read (path "x")))"#.into(),
            ),
            &registry,
            provenance(),
        )
        .is_err());
        assert!(decode_program_value(&serde_json::json!({
            "$yao": {"kind": "program", "hash": "sha256:forged", "value": {}}
        }))
        .is_err());
    }

    #[test]
    fn nested_program_values_consume_the_shared_depth_budget_without_refill() {
        let registry = fixture(&[]).0;
        let parent_source = r#"(eval
             (version "0.1")
             (seq
               (bind generated
                 (infer
                   (task "produce a pure integer program")
                   (returns (Program Int (effects)))))
               (run $generated)))"#;
        let program = validate(
            parent_source,
            &registry,
            &AllowList::new(Vec::<String>::new()),
        )
        .unwrap();
        let mut machine = PlanMachine::new(&program).unwrap();
        let provenance = || ProgramValueProvenance {
            parent_plan_execution_id: "recursive-parent".into(),
            producer_evaluation_id: "recursive-evaluation".into(),
            terminal_event_id: None,
            validation_version: "yao-0.1".into(),
        };
        let inference = match machine.advance(&registry) {
            PlanAdvance::Suspended(effect @ PlanEffect::Infer { .. }) => effect,
            other => panic!("expected Program-producing inference, got {other:?}"),
        };
        let PlanEffect::Infer { result, .. } = inference.clone() else {
            unreachable!()
        };
        let admitted = decode_infer_result_with_admission(
            result,
            JsonValue::String(r#"(eval (version "0.1") 42)"#.to_string()),
            &registry,
            provenance(),
        )
        .unwrap();
        machine
            .resume_effect(inference.sequence(), Ok(admitted.clone()))
            .unwrap();
        let child = match machine.advance(&registry) {
            PlanAdvance::Suspended(PlanEffect::Program { machine, .. }) => *machine,
            other => panic!("expected admitted child, got {other:?}"),
        };
        assert_eq!(machine.budget.programs_left, 0);
        assert_eq!(child.budget.programs_left, MAX_PROGRAM_VALUE_NESTING - 1);

        let mut exhausted = PlanMachine::new(&program).unwrap();
        let inference = match exhausted.advance(&registry) {
            PlanAdvance::Suspended(effect @ PlanEffect::Infer { .. }) => effect,
            other => panic!("expected Program-producing inference, got {other:?}"),
        };
        exhausted
            .resume_effect(inference.sequence(), Ok(admitted))
            .unwrap();
        exhausted.budget.programs_left = 0;
        match exhausted.advance(&registry) {
            PlanAdvance::Failed(error) => assert!(
                error.message.contains("嵌套超过上限"),
                "unexpected error: {error}"
            ),
            other => panic!("depth budget was silently refilled: {other:?}"),
        }
    }

    #[test]
    fn typed_tool_arguments_are_rejected_before_effect_handoff() {
        let registry = fixture(&[("read", JsonValue::Null)]).0;
        let error = validate(
            r#"(eval
                 (version "0.1")
                 (requires (tools read))
                 (call read (path 42)))"#,
            &registry,
            &AllowList::new(["read"]),
        )
        .unwrap_err();
        assert!(error.message.contains("Yao typed admission"), "{error}");
        assert!(error.message.contains("type"), "{error}");
        assert!(error.diagnostic.is_some());
    }

    #[test]
    fn typed_par_persists_isolated_child_machines_and_joins_in_source_order() {
        let registry = fixture(&[("read", JsonValue::Null)]).0;
        let program = validate(
            r#"(eval
                 (version "0.1")
                 (requires (tools read))
                 (par
                   (branch alpha (call read (path "a")))
                   (branch beta (call read (path "b")))))"#,
            &registry,
            &AllowList::new(["read"]),
        )
        .unwrap();
        let mut parent = PlanMachine::new(&program).unwrap();
        let effect = match parent.advance(&registry) {
            PlanAdvance::Suspended(effect @ PlanEffect::Parallel { .. }) => effect,
            other => panic!("expected persistent par boundary, got {other:?}"),
        };
        let encoded = serde_json::to_string(&parent).unwrap();
        let mut parent: PlanMachine = serde_json::from_str(&encoded).unwrap();
        assert_eq!(parent.pending_effect(), Some(&effect));

        let PlanEffect::Parallel { branches, sequence } = effect else {
            unreachable!()
        };
        assert_eq!(
            branches
                .iter()
                .map(|branch| branch.name.as_str())
                .collect::<Vec<_>>(),
            ["alpha", "beta"]
        );
        let mut results = Vec::new();
        for (index, branch) in branches.into_iter().enumerate() {
            let mut child = branch.machine;
            let call = match child.advance(&registry) {
                PlanAdvance::Suspended(effect @ PlanEffect::Call { .. }) => effect,
                other => panic!("expected branch call, got {other:?}"),
            };
            let encoded = serde_json::to_string(&child).unwrap();
            let mut child: PlanMachine = serde_json::from_str(&encoded).unwrap();
            let value = serde_json::json!(format!("result-{index}"));
            child
                .resume_effect(call.sequence(), Ok(value.clone()))
                .unwrap();
            assert_eq!(
                child.advance(&registry),
                PlanAdvance::Complete(value.clone())
            );
            results.push((branch.name, value));
        }
        parent
            .resume_effect(sequence, Ok(crate::yao::structural_record_value(results)))
            .unwrap();
        let PlanAdvance::Complete(value) = parent.advance(&registry) else {
            panic!("joined par did not complete")
        };
        let fields = value["$yao"]["fields"].as_array().unwrap();
        assert_eq!(fields[0]["name"], "alpha");
        assert_eq!(fields[1]["name"], "beta");
        assert_eq!(fields[0]["value"], "result-0");
        assert_eq!(fields[1]["value"], "result-1");
    }

    #[tokio::test]
    async fn convenience_evaluator_preserves_par_isolation_and_result_order() {
        let (registry, calls) = fixture(&[("read", JsonValue::Null)]);
        let program = validate(
            r#"(eval
                 (version "0.1")
                 (requires (tools read))
                 (par
                   (branch first (call read (path "one")))
                   (branch second (call read (path "two")))))"#,
            &registry,
            &AllowList::new(["read"]),
        )
        .unwrap();
        let value = evaluate(&program, registry, host("unused").0)
            .await
            .unwrap();
        let fields = value["$yao"]["fields"].as_array().unwrap();
        assert_eq!(fields[0]["name"], "first");
        assert_eq!(fields[1]["name"], "second");
        assert_eq!(calls.lock().unwrap().len(), 2);
    }
}
