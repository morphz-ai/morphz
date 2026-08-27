use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::canonical::{canonical_source, program_hash};
use crate::diagnostic::{Diagnostic, DiagnosticCode, SourceSpan};
use crate::syntax::{parse_one, AtomKind, Expr, ParseLimits};
use crate::types::{Effect, EffectSet, Type};
use crate::TYPED_IR_SCHEMA_VERSION;

pub const DEFAULT_MAX_EXPRESSION_DEPTH: usize = 32;
pub const DEFAULT_MAX_HIR_NODES: usize = 4_096;
pub const DEFAULT_MAX_FIELDS: usize = 256;
pub const DEFAULT_MAX_PAR_BRANCHES: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AnalysisLimits {
    pub parse: ParseLimits,
    pub max_expression_depth: usize,
    pub max_hir_nodes: usize,
    pub max_fields: usize,
    pub max_par_branches: usize,
}

impl Default for AnalysisLimits {
    fn default() -> Self {
        Self {
            parse: ParseLimits::default(),
            max_expression_depth: DEFAULT_MAX_EXPRESSION_DEPTH,
            max_hir_nodes: DEFAULT_MAX_HIR_NODES,
            max_fields: DEFAULT_MAX_FIELDS,
            max_par_branches: DEFAULT_MAX_PAR_BRANCHES,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationOwner {
    Runtime,
    Model,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldDefinition {
    pub name: String,
    pub ty: Type,
    pub span: SourceSpan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VariantDefinition {
    pub name: String,
    pub fields: Vec<FieldDefinition>,
    pub span: SourceSpan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TypeDefinition {
    Record {
        name: String,
        fields: Vec<FieldDefinition>,
        span: SourceSpan,
    },
    Union {
        name: String,
        variants: Vec<VariantDefinition>,
        span: SourceSpan,
    },
}

impl TypeDefinition {
    pub fn name(&self) -> &str {
        match self {
            Self::Record { name, .. } | Self::Union { name, .. } => name,
        }
    }

    pub const fn span(&self) -> SourceSpan {
        match self {
            Self::Record { span, .. } | Self::Union { span, .. } => *span,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Requirements {
    pub tools: Option<BTreeSet<String>>,
    pub effects: Option<EffectSet>,
    pub objects: Option<BTreeSet<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Program {
    pub language_version: String,
    pub owner: EvaluationOwner,
    pub requirements: Requirements,
    pub types: BTreeMap<String, TypeDefinition>,
    pub body: HirExpr,
    pub output: Type,
    pub effects: EffectSet,
    pub canonical_source: String,
    pub source_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolSignature {
    pub arguments: BTreeMap<String, Type>,
    pub required: BTreeSet<String>,
    pub result: Type,
}

impl ToolSignature {
    pub fn dynamic_json() -> Self {
        Self {
            arguments: BTreeMap::new(),
            required: BTreeSet::new(),
            result: Type::Json,
        }
    }
}

/// Static information supplied by a host profile. No method grants authority or performs an
/// operation; it only lets the language frontend type and reject a candidate program.
pub trait AnalysisProfile {
    fn tool_signature(&self, name: &str) -> Option<ToolSignature>;

    fn host_signature(&self, _name: &str) -> Option<ToolSignature> {
        None
    }

    fn implicit_binding(&self, _name: &str) -> Option<Type> {
        None
    }
}

#[derive(Debug, Clone, Default)]
pub struct StaticProfile {
    pub tools: BTreeMap<String, ToolSignature>,
    pub host_operations: BTreeMap<String, ToolSignature>,
    pub bindings: BTreeMap<String, Type>,
}

impl AnalysisProfile for StaticProfile {
    fn tool_signature(&self, name: &str) -> Option<ToolSignature> {
        self.tools.get(name).cloned()
    }

    fn host_signature(&self, name: &str) -> Option<ToolSignature> {
        self.host_operations.get(name).cloned()
    }

    fn implicit_binding(&self, name: &str) -> Option<Type> {
        self.bindings.get(name).cloned()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HirExpr {
    pub kind: HirKind,
    pub ty: Type,
    pub effects: EffectSet,
    pub span: SourceSpan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamedArgument {
    pub name: String,
    pub values: Vec<HirExpr>,
    pub span: SourceSpan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MatchBinding {
    pub field: String,
    pub binding: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MatchCase {
    pub variant: String,
    pub bindings: Vec<MatchBinding>,
    pub body: HirExpr,
    pub span: SourceSpan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParBranch {
    pub name: String,
    pub body: HirExpr,
    pub span: SourceSpan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum Literal {
    Nil,
    Bool(bool),
    Int(i64),
    /// Preserves the source decimal instead of admitting NaN or losing canonical identity.
    Float(String),
    String(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PureOperator {
    Equal,
    NotEqual,
    Less,
    LessEqual,
    Greater,
    GreaterEqual,
    And,
    Or,
    Not,
    Add,
    Subtract,
    Multiply,
    Divide,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum HirKind {
    Literal {
        value: Literal,
    },
    Reference {
        root: String,
        path: Vec<String>,
    },
    List {
        elements: Vec<HirExpr>,
    },
    Dict {
        entries: Vec<(String, HirExpr)>,
    },
    Record {
        type_name: String,
        fields: Vec<(String, HirExpr)>,
    },
    Variant {
        type_name: String,
        variant: String,
        fields: Vec<(String, HirExpr)>,
    },
    OptionSome {
        value: Box<HirExpr>,
    },
    OptionNone {
        inner: Type,
    },
    ResultOk {
        value: Box<HirExpr>,
        error: Type,
    },
    ResultErr {
        value: Box<HirExpr>,
        ok: Type,
    },
    EvidenceCandidate {
        kind: Box<HirExpr>,
        value: Box<HirExpr>,
        refs: Vec<HirExpr>,
    },
    OutcomeCandidate {
        status: String,
        value: Box<HirExpr>,
        evidence: Vec<HirExpr>,
    },
    ContextTransaction {
        context: Box<HirExpr>,
        canonical_source: String,
    },
    Get {
        value: Box<HirExpr>,
        field: String,
    },
    Decode {
        target: Type,
        value: Box<HirExpr>,
    },
    Is {
        target: Type,
        value: Box<HirExpr>,
    },
    Pure {
        operator: PureOperator,
        operands: Vec<HirExpr>,
    },
    Seq {
        steps: Vec<HirExpr>,
    },
    Bind {
        name: String,
        value: Box<HirExpr>,
    },
    If {
        condition: Box<HirExpr>,
        when_true: Box<HirExpr>,
        when_false: Box<HirExpr>,
    },
    Match {
        value: Box<HirExpr>,
        cases: Vec<MatchCase>,
    },
    Fallback {
        primary: Box<HirExpr>,
        backup: Box<HirExpr>,
    },
    Map {
        collection: Box<HirExpr>,
        element: String,
        body: Box<HirExpr>,
    },
    Call {
        tool: String,
        arguments: Vec<NamedArgument>,
    },
    Infer {
        arguments: Vec<NamedArgument>,
        tools: Option<Vec<String>>,
        result: Type,
    },
    /// A complete Yao expression whose Evaluation Loop is owned by the model.
    ///
    /// This is the canonical `infer` form. The body is analyzed by the same
    /// frontend as an `eval` body, so changing only the outer owner preserves
    /// the program tree, type, and statically visible effects. `source` is the
    /// canonical `(infer BODY)` artifact shown to the model at the ownership
    /// boundary. The older named request form remains readable as `Infer`
    /// during migration but is not the language's canonical evaluator form.
    InferBody {
        body: Box<HirExpr>,
        /// Lexical values that the source explicitly permits to cross from
        /// the Runtime-owned parent into this model-owned Evaluation.
        ///
        /// Captures are declarations, not an implicit serialization of the
        /// Plan Machine environment.  This keeps the ownership boundary
        /// auditable and prevents an unrelated binding from leaking merely
        /// because it happened to be live at the suspension point.
        #[serde(default)]
        captures: Vec<String>,
        /// The typed terminal result accepted from the model.  Without an
        /// explicit `(returns TYPE)` declaration this is the statically
        /// inferred BODY type. Ordinary declarations must accept the BODY
        /// type. `Program<T,E>` is the one synthesis contract: the complete
        /// BODY specifies how the model derives a quarantined candidate whose
        /// own output/effects are then independently admitted by Runtime.
        result: Type,
        source: String,
    },
    Par {
        branches: Vec<ParBranch>,
    },
    Run {
        program: Box<HirExpr>,
    },
    Host {
        operation: String,
        arguments: Vec<NamedArgument>,
    },
}

#[derive(Debug, Clone)]
struct Scope {
    bindings: HashMap<String, Type>,
    allow_implicit_bindings: bool,
}

impl Scope {
    fn new(profile: &dyn AnalysisProfile) -> Self {
        let mut bindings = HashMap::new();
        for name in ["runtime"] {
            if let Some(ty) = profile.implicit_binding(name) {
                bindings.insert(name.to_string(), ty);
            }
        }
        Self {
            bindings,
            allow_implicit_bindings: true,
        }
    }

    fn empty() -> Self {
        Self {
            bindings: HashMap::new(),
            allow_implicit_bindings: false,
        }
    }
}

pub fn analyze(
    source: &str,
    profile: &dyn AnalysisProfile,
    limits: AnalysisLimits,
) -> Result<Program, Diagnostic> {
    let root = parse_one(source, limits.parse)?;
    Analyzer::new(profile, limits).analyze_program(&root)
}

struct Analyzer<'a> {
    profile: &'a dyn AnalysisProfile,
    limits: AnalysisLimits,
    requirements: Requirements,
    definitions: BTreeMap<String, TypeDefinition>,
    node_count: usize,
}

impl<'a> Analyzer<'a> {
    fn new(profile: &'a dyn AnalysisProfile, limits: AnalysisLimits) -> Self {
        Self {
            profile,
            limits,
            requirements: Requirements::default(),
            definitions: BTreeMap::new(),
            node_count: 0,
        }
    }

    fn analyze_program(mut self, root: &Expr) -> Result<Program, Diagnostic> {
        let items = expect_list(root, "program root must be (eval ...) or (infer ...)")?;
        let Some(owner_name) = items.first().and_then(Expr::as_symbol) else {
            return Err(diag(
                DiagnosticCode::UnknownOperator,
                "program root is missing an evaluation owner",
                root.span(),
            ));
        };
        let owner = match owner_name {
            "eval" => EvaluationOwner::Runtime,
            "infer" => EvaluationOwner::Model,
            other => {
                return Err(diag(
                    DiagnosticCode::UnknownOperator,
                    format!("unknown program root '{other}'; expected eval or infer"),
                    items[0].span(),
                ))
            }
        };

        let mut cursor = 1;
        if is_form(items.get(cursor), "version") {
            return Err(diag(
                DiagnosticCode::InvalidType,
                "Yao source has no in-band version declaration; remove (version ...)",
                items[cursor].span(),
            ));
        }
        if is_form(items.get(cursor), "requires") {
            self.requirements = self.parse_requirements(&items[cursor])?;
            cursor += 1;
        }
        if is_form(items.get(cursor), "types") {
            self.definitions = self.parse_type_definitions(&items[cursor])?;
            self.validate_type_definitions()?;
            cursor += 1;
        }

        let mut scope = Scope::new(self.profile);
        let mut body = match owner {
            EvaluationOwner::Runtime => {
                if items.len().saturating_sub(cursor) != 1 {
                    return Err(diag(
                        DiagnosticCode::InvalidType,
                        "eval requires exactly one body after declarations; use seq for multiple steps",
                        root.span(),
                    ));
                }
                self.analyze_expr(&items[cursor], &mut scope, 0)?
            }
            EvaluationOwner::Model => {
                if cursor >= items.len() {
                    return Err(diag(
                        DiagnosticCode::InvalidType,
                        "infer requires one Yao body",
                        root.span(),
                    ));
                }
                self.analyze_infer(&items[cursor..], &mut scope, root.span(), true, 0)?
            }
        };
        if owner == EvaluationOwner::Model {
            let HirKind::InferBody { source, .. } = &mut body.kind else {
                // A legacy fixed request deliberately retains its migration
                // representation. Canonical complete-BODY roots preserve the
                // entire source artifact, including requires/types declarations.
                return self.finish_program(root, owner, body);
            };
            *source = canonical_source(root);
        }
        self.finish_program(root, owner, body)
    }

    fn finish_program(
        self,
        root: &Expr,
        owner: EvaluationOwner,
        body: HirExpr,
    ) -> Result<Program, Diagnostic> {
        if let Some(declared) = &self.requirements.effects {
            if !body.effects.is_subset(declared) {
                return Err(diag(
                    DiagnosticCode::EffectEscape,
                    format!(
                        "program effects {:?} exceed declared upper bound {:?}",
                        body.effects, declared
                    ),
                    body.span,
                ));
            }
        }
        let mut program = Program {
            language_version: TYPED_IR_SCHEMA_VERSION.to_string(),
            owner,
            requirements: self.requirements,
            types: self.definitions,
            output: body.ty.clone(),
            effects: body.effects.clone(),
            body,
            canonical_source: canonical_source(root),
            source_hash: String::new(),
        };
        program.source_hash = program_hash(&program);
        Ok(program)
    }

    fn analyze_expr(
        &mut self,
        expression: &Expr,
        scope: &mut Scope,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        if depth > self.limits.max_expression_depth {
            return Err(diag(
                DiagnosticCode::ResourceLimit,
                format!(
                    "expression depth exceeds {}",
                    self.limits.max_expression_depth
                ),
                expression.span(),
            ));
        }
        self.node_count += 1;
        if self.node_count > self.limits.max_hir_nodes {
            return Err(diag(
                DiagnosticCode::ResourceLimit,
                format!("typed HIR exceeds {} nodes", self.limits.max_hir_nodes),
                expression.span(),
            ));
        }
        match expression {
            Expr::Atom(_) => self.analyze_atom(expression, scope),
            Expr::List { items, .. } => {
                let Some(operator) = items.first().and_then(Expr::as_symbol) else {
                    return Err(diag(
                        DiagnosticCode::UnknownOperator,
                        "expression list must start with an operator symbol",
                        expression.span(),
                    ));
                };
                let arguments = &items[1..];
                match operator {
                    "list" => self.analyze_list(arguments, scope, expression.span(), depth),
                    "dict" => self.analyze_dict(arguments, scope, expression.span(), depth),
                    "record" => self.analyze_record(arguments, scope, expression.span(), depth),
                    "variant" => self.analyze_variant(arguments, scope, expression.span(), depth),
                    "some" => self.analyze_some(arguments, scope, expression.span(), depth),
                    "none" => self.analyze_none(arguments, expression.span()),
                    "ok" => self.analyze_ok(arguments, scope, expression.span(), depth),
                    "err" => self.analyze_err(arguments, scope, expression.span(), depth),
                    "evidence" => self.analyze_evidence(arguments, scope, expression.span(), depth),
                    "outcome" => self.analyze_outcome(arguments, scope, expression.span(), depth),
                    "context-transaction" => {
                        self.analyze_context_transaction(arguments, scope, expression.span(), depth)
                    }
                    "get" => self.analyze_get(arguments, scope, expression.span(), depth),
                    "decode" => self.analyze_decode(arguments, scope, expression.span(), depth),
                    "is" => self.analyze_is(arguments, scope, expression.span(), depth),
                    "eq" | "ne" | "lt" | "le" | "gt" | "ge" | "and" | "or" | "not" | "add"
                    | "sub" | "mul" | "div" => {
                        self.analyze_pure(operator, arguments, scope, expression.span(), depth)
                    }
                    "seq" => self.analyze_seq(arguments, scope, expression.span(), depth),
                    "bind" => self.analyze_bind(arguments, scope, expression.span(), depth),
                    "if" => self.analyze_if(arguments, scope, expression.span(), depth),
                    "match" => self.analyze_match(arguments, scope, expression.span(), depth),
                    "fallback" => self.analyze_fallback(arguments, scope, expression.span(), depth),
                    "map" => self.analyze_map(arguments, scope, expression.span(), depth),
                    "call" => self.analyze_call(arguments, scope, expression.span(), depth),
                    "infer" => {
                        self.analyze_infer(arguments, scope, expression.span(), false, depth)
                    }
                    "par" => self.analyze_par(arguments, scope, expression.span(), depth),
                    "run" => self.analyze_run(arguments, scope, expression.span(), depth),
                    "host.view" => {
                        self.analyze_host_view(arguments, scope, expression.span(), depth)
                    }
                    "evidence.commit" | "outcome.commit" => self.analyze_host_unary(
                        operator,
                        "candidate",
                        arguments,
                        scope,
                        expression.span(),
                        depth,
                    ),
                    "context.propose" => self.analyze_host_unary(
                        operator,
                        "transaction",
                        arguments,
                        scope,
                        expression.span(),
                        depth,
                    ),
                    name if name.contains('.') => {
                        self.analyze_host(name, arguments, scope, expression.span(), depth)
                    }
                    other => Err(diag(
                        DiagnosticCode::UnknownOperator,
                        format!("unknown Yao operator '{other}'"),
                        items[0].span(),
                    )),
                }
            }
        }
    }

    fn analyze_atom(&self, expression: &Expr, scope: &Scope) -> Result<HirExpr, Diagnostic> {
        let Expr::Atom(atom) = expression else {
            unreachable!()
        };
        if atom.kind == AtomKind::String {
            return Ok(hir(
                HirKind::Literal {
                    value: Literal::String(atom.value.clone()),
                },
                Type::String,
                EffectSet::default(),
                atom.span,
            ));
        }
        if let Some(reference) = atom.value.strip_prefix('$') {
            let replacement = if reference.is_empty() {
                "a bare binding name".to_string()
            } else {
                format!("'{reference}'")
            };
            return Err(diag(
                DiagnosticCode::UnknownName,
                format!(
                    "binding references do not use '$'; replace '{}' with {replacement}",
                    atom.value
                ),
                atom.span,
            ));
        }
        let (literal, ty) = match atom.value.as_str() {
            "nil" => (Literal::Nil, Type::Nil),
            "true" => (Literal::Bool(true), Type::Bool),
            "false" => (Literal::Bool(false), Type::Bool),
            value if value.parse::<i64>().is_ok() => (
                Literal::Int(value.parse::<i64>().expect("checked above")),
                Type::Int,
            ),
            value if looks_like_float_literal(value) => {
                if value.parse::<f64>().is_err() {
                    return Err(diag(
                        DiagnosticCode::TypeMismatch,
                        format!("invalid Float literal '{value}'"),
                        atom.span,
                    ));
                }
                (Literal::Float(value.to_string()), Type::Float)
            }
            symbol => return self.analyze_reference(symbol, atom.span, scope),
        };
        Ok(hir(
            HirKind::Literal { value: literal },
            ty,
            EffectSet::default(),
            atom.span,
        ))
    }

    fn analyze_reference(
        &self,
        reference: &str,
        span: SourceSpan,
        scope: &Scope,
    ) -> Result<HirExpr, Diagnostic> {
        let mut segments = reference.split('.');
        let root = segments.next().unwrap_or_default();
        if root.is_empty() {
            return Err(diag(
                DiagnosticCode::UnknownName,
                "binding reference must contain a name",
                span,
            ));
        }
        let Some(mut ty) = scope.bindings.get(root).cloned().or_else(|| {
            scope
                .allow_implicit_bindings
                .then(|| self.profile.implicit_binding(root))
                .flatten()
        }) else {
            return Err(diag(
                DiagnosticCode::UnknownName,
                format!("unknown binding '{root}'"),
                span,
            ));
        };
        let path = segments.map(str::to_string).collect::<Vec<_>>();
        for field in &path {
            ty = self.field_type(&ty, field, span)?;
        }
        Ok(hir(
            HirKind::Reference {
                root: root.to_string(),
                path,
            },
            ty,
            EffectSet::default(),
            span,
        ))
    }

    fn analyze_list(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let elements = self.analyze_many(arguments, scope, depth + 1)?;
        require_pure_all(elements.iter(), "list elements")?;
        let element_type =
            common_types(elements.iter().map(|value| &value.ty), span)?.unwrap_or(Type::Json);
        Ok(hir(
            HirKind::List {
                elements: elements.clone(),
            },
            Type::List(Box::new(element_type)),
            union_effects(elements.iter()),
            span,
        ))
    }

    fn analyze_dict(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        if arguments.len() > self.limits.max_fields {
            return Err(resource_fields(
                arguments.len(),
                self.limits.max_fields,
                span,
            ));
        }
        let mut names = HashSet::new();
        let mut entries = Vec::new();
        for argument in arguments {
            let items = expect_list(argument, "dict entries must be (KEY EXPR)")?;
            let [key, value] = items else {
                return Err(diag(
                    DiagnosticCode::TypeMismatch,
                    "dict entries must contain exactly a key and value",
                    argument.span(),
                ));
            };
            let key = atom_text(key, "dict key must be a symbol or string")?;
            if !names.insert(key.to_string()) {
                return Err(diag(
                    DiagnosticCode::DuplicateName,
                    format!("duplicate dict key '{key}'"),
                    key_span(key, items[0].span()),
                ));
            }
            entries.push((key.to_string(), self.analyze_expr(value, scope, depth + 1)?));
        }
        let value_type = infer_dict_value_type(&entries)?.unwrap_or(Type::Json);
        require_pure_all(entries.iter().map(|(_, value)| value), "dict values")?;
        Ok(hir(
            HirKind::Dict {
                entries: entries.clone(),
            },
            Type::Map(Box::new(value_type)),
            union_effects(entries.iter().map(|(_, value)| value)),
            span,
        ))
    }

    fn analyze_record(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let Some(type_expr) = arguments.first() else {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "record requires a nominal type name",
                span,
            ));
        };
        let type_name = expect_symbol(type_expr, "record type must be a symbol")?;
        let Some(TypeDefinition::Record { fields, .. }) = self.definitions.get(type_name).cloned()
        else {
            return Err(diag(
                DiagnosticCode::InvalidType,
                format!("'{type_name}' is not a declared record type"),
                type_expr.span(),
            ));
        };
        let values = self.analyze_named_fields(&arguments[1..], &fields, scope, depth + 1)?;
        require_pure_all(values.iter().map(|(_, value)| value), "record fields")?;
        Ok(hir(
            HirKind::Record {
                type_name: type_name.to_string(),
                fields: values.clone(),
            },
            Type::Named(type_name.to_string()),
            union_effects(values.iter().map(|(_, value)| value)),
            span,
        ))
    }

    fn analyze_variant(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let Some(constructor) = arguments.first() else {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "variant requires TYPE.VARIANT",
                span,
            ));
        };
        let constructor = expect_symbol(constructor, "variant constructor must be TYPE.VARIANT")?;
        let Some((type_name, variant_name)) = constructor.rsplit_once('.') else {
            return Err(diag(
                DiagnosticCode::InvalidType,
                "variant constructor must be TYPE.VARIANT",
                arguments[0].span(),
            ));
        };
        let Some(TypeDefinition::Union { variants, .. }) = self.definitions.get(type_name).cloned()
        else {
            return Err(diag(
                DiagnosticCode::InvalidType,
                format!("'{type_name}' is not a declared union type"),
                arguments[0].span(),
            ));
        };
        let Some(variant) = variants.iter().find(|value| value.name == variant_name) else {
            return Err(diag(
                DiagnosticCode::InvalidType,
                format!("union '{type_name}' has no variant '{variant_name}'"),
                arguments[0].span(),
            ));
        };
        let values =
            self.analyze_named_fields(&arguments[1..], &variant.fields, scope, depth + 1)?;
        require_pure_all(values.iter().map(|(_, value)| value), "variant fields")?;
        Ok(hir(
            HirKind::Variant {
                type_name: type_name.to_string(),
                variant: variant_name.to_string(),
                fields: values.clone(),
            },
            Type::Named(type_name.to_string()),
            union_effects(values.iter().map(|(_, value)| value)),
            span,
        ))
    }

    fn analyze_some(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let [value] = arguments else {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "some requires exactly one value",
                span,
            ));
        };
        let value = self.analyze_expr(value, scope, depth + 1)?;
        require_pure(&value, "some payload")?;
        Ok(hir(
            HirKind::OptionSome {
                value: Box::new(value.clone()),
            },
            Type::Option(Box::new(value.ty.clone())),
            value.effects,
            span,
        ))
    }

    fn analyze_none(&self, arguments: &[Expr], span: SourceSpan) -> Result<HirExpr, Diagnostic> {
        let [inner] = arguments else {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "none requires exactly one element type",
                span,
            ));
        };
        let inner = self.parse_type(inner)?;
        self.validate_type_names(&inner, span)?;
        Ok(hir(
            HirKind::OptionNone {
                inner: inner.clone(),
            },
            Type::Option(Box::new(inner)),
            EffectSet::default(),
            span,
        ))
    }

    fn analyze_ok(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let [value, error] = arguments else {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "ok requires a value and the Result error type",
                span,
            ));
        };
        let value = self.analyze_expr(value, scope, depth + 1)?;
        require_pure(&value, "ok payload")?;
        let error = self.parse_type(error)?;
        self.validate_type_names(&error, span)?;
        Ok(hir(
            HirKind::ResultOk {
                value: Box::new(value.clone()),
                error: error.clone(),
            },
            Type::Result {
                ok: Box::new(value.ty.clone()),
                error: Box::new(error),
            },
            value.effects,
            span,
        ))
    }

    fn analyze_err(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let [value, ok] = arguments else {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "err requires a value and the Result success type",
                span,
            ));
        };
        let value = self.analyze_expr(value, scope, depth + 1)?;
        require_pure(&value, "err payload")?;
        let ok = self.parse_type(ok)?;
        self.validate_type_names(&ok, span)?;
        Ok(hir(
            HirKind::ResultErr {
                value: Box::new(value.clone()),
                ok: ok.clone(),
            },
            Type::Result {
                ok: Box::new(ok),
                error: Box::new(value.ty.clone()),
            },
            value.effects,
            span,
        ))
    }

    fn analyze_evidence(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let mut kind = None;
        let mut value = None;
        let mut refs = Vec::new();
        let mut seen = HashSet::new();
        for clause in arguments {
            let items = expect_list(clause, "evidence fields must be (NAME EXPR...)")?;
            let Some(name) = items.first().and_then(Expr::as_symbol) else {
                return Err(diag(
                    DiagnosticCode::TypeMismatch,
                    "evidence field has no name",
                    clause.span(),
                ));
            };
            if !seen.insert(name) {
                return Err(duplicate_declaration(name, clause.span()));
            }
            match name {
                "kind" | "value" => {
                    let [_, expression] = items else {
                        return Err(diag(
                            DiagnosticCode::TypeMismatch,
                            format!("evidence {name} requires exactly one value"),
                            clause.span(),
                        ));
                    };
                    let expression = self.analyze_expr(expression, scope, depth + 1)?;
                    require_pure(&expression, "evidence candidate field")?;
                    if name == "kind" {
                        require_assignable(&expression.ty, &Type::String, expression.span)?;
                        kind = Some(expression);
                    } else {
                        value = Some(expression);
                    }
                }
                "refs" => {
                    refs = self.analyze_many(&items[1..], scope, depth + 1)?;
                    require_pure_all(refs.iter(), "evidence refs")?;
                    for reference in &refs {
                        require_assignable(
                            &reference.ty,
                            &Type::Ref("Evidence".into()),
                            reference.span,
                        )?;
                    }
                }
                other => {
                    return Err(diag(
                        DiagnosticCode::UnknownName,
                        format!("unknown evidence field '{other}'"),
                        clause.span(),
                    ))
                }
            }
        }
        let kind = kind.ok_or_else(|| {
            diag(
                DiagnosticCode::TypeMismatch,
                "evidence requires (kind String)",
                span,
            )
        })?;
        let value = value.ok_or_else(|| {
            diag(
                DiagnosticCode::TypeMismatch,
                "evidence requires (value EXPR)",
                span,
            )
        })?;
        Ok(hir(
            HirKind::EvidenceCandidate {
                kind: Box::new(kind),
                value: Box::new(value),
                refs,
            },
            Type::EvidenceCandidate,
            EffectSet::default(),
            span,
        ))
    }

    fn analyze_outcome(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let mut status = None;
        let mut value = None;
        let mut evidence = Vec::new();
        let mut seen = HashSet::new();
        for clause in arguments {
            let items = expect_list(clause, "outcome fields must be (NAME EXPR...)")?;
            let Some(name) = items.first().and_then(Expr::as_symbol) else {
                return Err(diag(
                    DiagnosticCode::TypeMismatch,
                    "outcome field has no name",
                    clause.span(),
                ));
            };
            if !seen.insert(name) {
                return Err(duplicate_declaration(name, clause.span()));
            }
            match name {
                "status" => {
                    let [_, status_expr] = items else {
                        return Err(diag(
                            DiagnosticCode::TypeMismatch,
                            "outcome status requires exactly one symbol",
                            clause.span(),
                        ));
                    };
                    let candidate = expect_symbol(status_expr, "outcome status must be a symbol")?;
                    if !matches!(candidate, "succeeded" | "failed" | "blocked") {
                        return Err(diag(
                            DiagnosticCode::InvalidType,
                            "outcome status must be succeeded, failed, or blocked",
                            status_expr.span(),
                        ));
                    }
                    status = Some(candidate.to_string());
                }
                "value" => {
                    let [_, expression] = items else {
                        return Err(diag(
                            DiagnosticCode::TypeMismatch,
                            "outcome value requires exactly one expression",
                            clause.span(),
                        ));
                    };
                    let expression = self.analyze_expr(expression, scope, depth + 1)?;
                    require_pure(&expression, "outcome value")?;
                    value = Some(expression);
                }
                "evidence" => {
                    evidence = self.analyze_many(&items[1..], scope, depth + 1)?;
                    require_pure_all(evidence.iter(), "outcome evidence")?;
                    for reference in &evidence {
                        require_assignable(
                            &reference.ty,
                            &Type::Ref("Evidence".into()),
                            reference.span,
                        )?;
                    }
                }
                other => {
                    return Err(diag(
                        DiagnosticCode::UnknownName,
                        format!("unknown outcome field '{other}'"),
                        clause.span(),
                    ))
                }
            }
        }
        let status = status.ok_or_else(|| {
            diag(
                DiagnosticCode::TypeMismatch,
                "outcome requires (status succeeded|failed|blocked)",
                span,
            )
        })?;
        let value = value.unwrap_or_else(|| {
            hir(
                HirKind::Literal {
                    value: Literal::Nil,
                },
                Type::Nil,
                EffectSet::default(),
                span,
            )
        });
        Ok(hir(
            HirKind::OutcomeCandidate {
                status,
                value: Box::new(value),
                evidence,
            },
            Type::OutcomeCandidate,
            EffectSet::default(),
            span,
        ))
    }

    fn analyze_context_transaction(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let mut context = None;
        let mut transaction = None;
        let mut seen = HashSet::new();
        for clause in arguments {
            let items = expect_list(
                clause,
                "context-transaction fields must be (context EXPR) and (transaction (context-tx ...))",
            )?;
            let Some(name) = items.first().and_then(Expr::as_symbol) else {
                return Err(diag(
                    DiagnosticCode::TypeMismatch,
                    "context-transaction field has no name",
                    clause.span(),
                ));
            };
            if !seen.insert(name) {
                return Err(duplicate_declaration(name, clause.span()));
            }
            match name {
                "context" => {
                    let [_, expression] = items else {
                        return Err(diag(
                            DiagnosticCode::TypeMismatch,
                            "context-transaction context requires exactly one Ref<Context>",
                            clause.span(),
                        ));
                    };
                    let expression = self.analyze_expr(expression, scope, depth + 1)?;
                    require_pure(&expression, "context-transaction context")?;
                    require_assignable(
                        &expression.ty,
                        &Type::Ref("Context".into()),
                        expression.span,
                    )?;
                    context = Some(expression);
                }
                "transaction" => {
                    let [_, source] = items else {
                        return Err(diag(
                            DiagnosticCode::TypeMismatch,
                            "context-transaction transaction requires exactly one (context-tx ...) form",
                            clause.span(),
                        ));
                    };
                    let source_items = expect_list(source, "transaction must be (context-tx ...)")?;
                    if source_items.first().and_then(Expr::as_symbol) != Some("context-tx") {
                        return Err(diag(
                            DiagnosticCode::TypeMismatch,
                            "transaction must start with context-tx",
                            source.span(),
                        ));
                    }
                    transaction = Some(canonical_source(source));
                }
                other => {
                    return Err(diag(
                        DiagnosticCode::UnknownName,
                        format!("unknown context-transaction field '{other}'"),
                        clause.span(),
                    ))
                }
            }
        }
        let context = context.ok_or_else(|| {
            diag(
                DiagnosticCode::TypeMismatch,
                "context-transaction requires (context Ref<Context>)",
                span,
            )
        })?;
        let canonical_source = transaction.ok_or_else(|| {
            diag(
                DiagnosticCode::TypeMismatch,
                "context-transaction requires (transaction (context-tx ...))",
                span,
            )
        })?;
        Ok(hir(
            HirKind::ContextTransaction {
                context: Box::new(context),
                canonical_source,
            },
            Type::ContextTransaction,
            EffectSet::default(),
            span,
        ))
    }

    fn analyze_get(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let [value, field] = arguments else {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "get requires a value and static field name",
                span,
            ));
        };
        let value = self.analyze_expr(value, scope, depth + 1)?;
        require_pure(&value, "get operand")?;
        let field = atom_text(field, "get field must be a symbol or string")?.to_string();
        let ty = self.field_type(&value.ty, &field, span)?;
        Ok(hir(
            HirKind::Get {
                value: Box::new(value.clone()),
                field,
            },
            ty,
            value.effects,
            span,
        ))
    }

    fn analyze_decode(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let [target, value] = arguments else {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "decode requires TYPE and JSON-EXPR",
                span,
            ));
        };
        let target = self.parse_type(target)?;
        self.validate_type_names(&target, span)?;
        if self.contains_nonforgeable_type(&target, &mut HashSet::new()) {
            return Err(diag(
                DiagnosticCode::InvalidType,
                "decode cannot construct Ref or Program values; they require host injection or Runtime admission",
                span,
            ));
        }
        let value = self.analyze_expr(value, scope, depth + 1)?;
        require_pure(&value, "decode operand")?;
        require_assignable(&value.ty, &Type::Json, value.span)?;
        Ok(hir(
            HirKind::Decode {
                target: target.clone(),
                value: Box::new(value.clone()),
            },
            target,
            value.effects,
            span,
        ))
    }

    fn analyze_is(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let [target, value] = arguments else {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "is requires TYPE and EXPR",
                span,
            ));
        };
        let target = self.parse_type(target)?;
        let value = self.analyze_expr(value, scope, depth + 1)?;
        require_pure(&value, "is operand")?;
        Ok(hir(
            HirKind::Is {
                target,
                value: Box::new(value.clone()),
            },
            Type::Bool,
            value.effects,
            span,
        ))
    }

    fn analyze_pure(
        &mut self,
        name: &str,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let operands = self.analyze_many(arguments, scope, depth + 1)?;
        require_pure_all(operands.iter(), "pure operator operands")?;
        let operator = match name {
            "eq" => PureOperator::Equal,
            "ne" => PureOperator::NotEqual,
            "lt" => PureOperator::Less,
            "le" => PureOperator::LessEqual,
            "gt" => PureOperator::Greater,
            "ge" => PureOperator::GreaterEqual,
            "and" => PureOperator::And,
            "or" => PureOperator::Or,
            "not" => PureOperator::Not,
            "add" => PureOperator::Add,
            "sub" => PureOperator::Subtract,
            "mul" => PureOperator::Multiply,
            "div" => PureOperator::Divide,
            _ => unreachable!(),
        };
        let ty = match operator {
            PureOperator::Equal | PureOperator::NotEqual => {
                require_arity(name, &operands, 2, span)?;
                common_type(&operands[0].ty, &operands[1].ty).ok_or_else(|| {
                    diag(
                        DiagnosticCode::TypeMismatch,
                        format!("{name} operands have incompatible types"),
                        span,
                    )
                })?;
                Type::Bool
            }
            PureOperator::Less
            | PureOperator::LessEqual
            | PureOperator::Greater
            | PureOperator::GreaterEqual => {
                require_arity(name, &operands, 2, span)?;
                require_comparable(&operands[0].ty, &operands[1].ty, span)?;
                Type::Bool
            }
            PureOperator::And | PureOperator::Or => {
                if operands.len() < 2 {
                    return Err(diag(
                        DiagnosticCode::TypeMismatch,
                        format!("{name} requires at least two operands"),
                        span,
                    ));
                }
                for operand in &operands {
                    require_assignable(&operand.ty, &Type::Bool, operand.span)?;
                }
                Type::Bool
            }
            PureOperator::Not => {
                require_arity(name, &operands, 1, span)?;
                require_assignable(&operands[0].ty, &Type::Bool, operands[0].span)?;
                Type::Bool
            }
            PureOperator::Add | PureOperator::Multiply => {
                if operands.len() < 2 {
                    return Err(diag(
                        DiagnosticCode::TypeMismatch,
                        format!("{name} requires at least two operands"),
                        span,
                    ));
                }
                numeric_result(&operands, span)?
            }
            PureOperator::Subtract | PureOperator::Divide => {
                require_arity(name, &operands, 2, span)?;
                numeric_result(&operands, span)?
            }
        };
        Ok(hir(
            HirKind::Pure {
                operator,
                operands: operands.clone(),
            },
            ty,
            union_effects(operands.iter()),
            span,
        ))
    }

    fn analyze_seq(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        if arguments.is_empty() {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "seq requires at least one step",
                span,
            ));
        }
        let steps = self.analyze_many(arguments, scope, depth + 1)?;
        let ty = steps.last().expect("non-empty").ty.clone();
        Ok(hir(
            HirKind::Seq {
                steps: steps.clone(),
            },
            ty,
            union_effects(steps.iter()),
            span,
        ))
    }

    fn analyze_bind(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let [name, value] = arguments else {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "bind requires NAME and EXPR",
                span,
            ));
        };
        let name = expect_binding_name(name)?;
        if scope.bindings.contains_key(name) {
            return Err(diag(
                DiagnosticCode::DuplicateName,
                format!("binding '{name}' cannot be overwritten"),
                arguments[0].span(),
            ));
        }
        let value = self.analyze_expr(value, scope, depth + 1)?;
        scope.bindings.insert(name.to_string(), value.ty.clone());
        Ok(hir(
            HirKind::Bind {
                name: name.to_string(),
                value: Box::new(value.clone()),
            },
            Type::Nil,
            value.effects,
            span,
        ))
    }

    fn analyze_if(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let [condition, when_true, when_false] = arguments else {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "if requires CONDITION, THEN, and ELSE",
                span,
            ));
        };
        let condition = self.analyze_expr(condition, scope, depth + 1)?;
        require_pure(&condition, "if condition")?;
        require_assignable(&condition.ty, &Type::Bool, condition.span)?;
        let when_true = self.analyze_expr(when_true, &mut scope.clone(), depth + 1)?;
        let when_false = self.analyze_expr(when_false, &mut scope.clone(), depth + 1)?;
        let ty = common_type(&when_true.ty, &when_false.ty).ok_or_else(|| {
            diag(
                DiagnosticCode::TypeMismatch,
                "if branches have no common result type",
                span,
            )
        })?;
        let effects = condition
            .effects
            .union(&when_true.effects)
            .union(&when_false.effects);
        Ok(hir(
            HirKind::If {
                condition: Box::new(condition),
                when_true: Box::new(when_true),
                when_false: Box::new(when_false),
            },
            ty,
            effects,
            span,
        ))
    }

    fn analyze_fallback(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let [primary, backup] = arguments else {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "fallback requires PRIMARY and BACKUP",
                span,
            ));
        };
        let primary = self.analyze_expr(primary, &mut scope.clone(), depth + 1)?;
        let backup = self.analyze_expr(backup, &mut scope.clone(), depth + 1)?;
        let ty = common_type(&primary.ty, &backup.ty).ok_or_else(|| {
            diag(
                DiagnosticCode::TypeMismatch,
                "fallback branches have no common result type",
                span,
            )
        })?;
        let effects = primary.effects.union(&backup.effects);
        Ok(hir(
            HirKind::Fallback {
                primary: Box::new(primary),
                backup: Box::new(backup),
            },
            ty,
            effects,
            span,
        ))
    }

    fn analyze_map(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let [collection, element, body] = arguments else {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "map requires COLLECTION, ELEMENT, and BODY",
                span,
            ));
        };
        let collection = self.analyze_expr(collection, scope, depth + 1)?;
        require_pure(&collection, "map collection")?;
        let Type::List(element_type) = &collection.ty else {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "map collection must be List<T>",
                collection.span,
            ));
        };
        let element_name = expect_binding_name(element)?;
        let mut body_scope = scope.clone();
        if body_scope
            .bindings
            .insert(element_name.to_string(), *element_type.clone())
            .is_some()
        {
            return Err(diag(
                DiagnosticCode::DuplicateName,
                format!("map element '{element_name}' shadows an existing binding"),
                element.span(),
            ));
        }
        let body = self.analyze_expr(body, &mut body_scope, depth + 1)?;
        let effects = collection.effects.union(&body.effects);
        Ok(hir(
            HirKind::Map {
                collection: Box::new(collection),
                element: element_name.to_string(),
                body: Box::new(body.clone()),
            },
            Type::List(Box::new(body.ty)),
            effects,
            span,
        ))
    }

    fn analyze_call(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let Some(tool_expr) = arguments.first() else {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "call requires a static tool name",
                span,
            ));
        };
        let tool = expect_symbol(tool_expr, "tool name must be a symbol")?;
        if self
            .requirements
            .tools
            .as_ref()
            .is_some_and(|tools| !tools.contains(tool))
        {
            return Err(diag(
                DiagnosticCode::EffectEscape,
                format!("tool '{tool}' is outside the program requires.tools set"),
                tool_expr.span(),
            ));
        }
        let Some(signature) = self.profile.tool_signature(tool) else {
            return Err(diag(
                DiagnosticCode::UnknownName,
                format!("unknown tool '{tool}'"),
                tool_expr.span(),
            ));
        };
        let named = self.analyze_named_arguments(&arguments[1..], scope, depth + 1)?;
        require_pure_all(
            named.iter().flat_map(|argument| argument.values.iter()),
            "call arguments",
        )?;
        self.check_signature(&named, &signature, span)?;
        let mut effects = union_effects(named.iter().flat_map(|argument| argument.values.iter()));
        effects.insert(Effect::Tool(tool.to_string()));
        Ok(hir(
            HirKind::Call {
                tool: tool.to_string(),
                arguments: named,
            },
            signature.result,
            effects,
            span,
        ))
    }

    fn analyze_infer(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        root_model_owned: bool,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        // Compatibility with pre-BODY Yao artifacts. The canonical language
        // now uses `(infer BODY)`, but persisted programs and older Harness
        // packages may still carry the fixed named request shape.
        let legacy_request = arguments.iter().any(|argument| {
            argument
                .as_list()
                .and_then(|items| items.first())
                .and_then(Expr::as_symbol)
                .is_some_and(|name| matches!(name, "task" | "tools" | "model"))
        });
        if !legacy_request {
            return self.analyze_infer_body(arguments, scope, span, root_model_owned, depth);
        }

        self.analyze_legacy_infer(arguments, scope, span, root_model_owned, depth)
    }

    fn analyze_infer_body(
        &mut self,
        arguments: &[Expr],
        outer_scope: &Scope,
        span: SourceSpan,
        root_model_owned: bool,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let mut cursor = 0;
        let mut captures = Vec::new();
        if is_form(arguments.get(cursor), "captures") {
            let items = expect_list(&arguments[cursor], "captures must be a list")?;
            let mut seen = HashSet::new();
            for capture in &items[1..] {
                let name = expect_symbol(capture, "captures entries must be lexical names")?;
                if !seen.insert(name.to_string()) {
                    return Err(diag(
                        DiagnosticCode::DuplicateName,
                        format!("infer captures lexical name '{name}' more than once"),
                        capture.span(),
                    ));
                }
                if !outer_scope.bindings.contains_key(name) {
                    return Err(diag(
                        DiagnosticCode::UnknownName,
                        format!("infer capture '{name}' is not bound in the parent scope"),
                        capture.span(),
                    ));
                }
                captures.push(name.to_string());
            }
            cursor += 1;
        }

        let mut declared_result = None;
        if is_form(arguments.get(cursor), "returns") {
            let items = expect_list(&arguments[cursor], "returns must be a list")?;
            if items.len() != 2 {
                return Err(diag(
                    DiagnosticCode::InvalidType,
                    "infer result declaration must be exactly (returns TYPE)",
                    arguments[cursor].span(),
                ));
            }
            let result = self.parse_type(&items[1])?;
            self.validate_type_names(&result, arguments[cursor].span())?;
            declared_result = Some(result);
            cursor += 1;
        }

        if arguments.len().saturating_sub(cursor) != 1 {
            return Err(diag(
                DiagnosticCode::InvalidType,
                "infer requires exactly one complete Yao body after optional captures/returns declarations; use seq for multiple steps",
                span,
            ));
        }
        let body_source = &arguments[cursor];

        // Crossing from Runtime-owned control to a model-owned Evaluation is
        // an explicit closure boundary.  The BODY receives only bindings named
        // by `(captures ...)`; it never inherits the complete parent scope.
        let mut body_scope = Scope::empty();
        for name in &captures {
            let ty = outer_scope
                .bindings
                .get(name)
                .expect("capture existence checked above")
                .clone();
            body_scope.bindings.insert(name.clone(), ty);
        }
        let body = self.analyze_expr(body_source, &mut body_scope, depth + 1)?;
        let result = if let Some(declared) = declared_result {
            if !body.ty.is_assignable_to(&declared) && !matches!(declared, Type::Program { .. }) {
                return Err(diag(
                    DiagnosticCode::TypeMismatch,
                    format!(
                        "infer BODY type {:?} is not assignable to declared result {:?}",
                        body.ty, declared
                    ),
                    body.span,
                ));
            }
            declared
        } else {
            body.ty.clone()
        };
        let mut effects = body.effects.clone();
        if !root_model_owned {
            effects.insert(Effect::Infer);
        }
        let source = format!(
            "(infer {})",
            arguments
                .iter()
                .map(canonical_source)
                .collect::<Vec<_>>()
                .join(" ")
        );
        Ok(hir(
            HirKind::InferBody {
                body: Box::new(body),
                captures,
                result: result.clone(),
                source,
            },
            result,
            effects,
            span,
        ))
    }

    fn analyze_legacy_infer(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        root_model_owned: bool,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let mut result = None;
        let mut tools = None;
        let mut data = Vec::new();
        let mut has_task = false;
        for argument in arguments {
            let items = expect_list(argument, "infer arguments must be lists")?;
            let Some(name) = items.first().and_then(Expr::as_symbol) else {
                return Err(diag(
                    DiagnosticCode::TypeMismatch,
                    "infer argument must start with a name",
                    argument.span(),
                ));
            };
            match name {
                "returns" => {
                    if result.is_some() || items.len() != 2 {
                        return Err(diag(
                            DiagnosticCode::DuplicateName,
                            "infer requires exactly one (returns TYPE)",
                            argument.span(),
                        ));
                    }
                    result = Some(self.parse_infer_result(&items[1])?);
                }
                "tools" => {
                    if tools.is_some() {
                        return Err(diag(
                            DiagnosticCode::DuplicateName,
                            "infer contains more than one tools clause",
                            argument.span(),
                        ));
                    }
                    let mut names = Vec::new();
                    let mut seen = HashSet::new();
                    for tool_expr in &items[1..] {
                        let tool = expect_symbol(tool_expr, "infer tools must be static symbols")?;
                        if !seen.insert(tool.to_string()) {
                            return Err(diag(
                                DiagnosticCode::DuplicateName,
                                format!("infer repeats tool '{tool}'"),
                                tool_expr.span(),
                            ));
                        }
                        if self
                            .requirements
                            .tools
                            .as_ref()
                            .is_some_and(|allowed| !allowed.contains(tool))
                        {
                            return Err(diag(
                                DiagnosticCode::EffectEscape,
                                format!("infer tool '{tool}' exceeds requires.tools"),
                                tool_expr.span(),
                            ));
                        }
                        if self.profile.tool_signature(tool).is_none() {
                            return Err(diag(
                                DiagnosticCode::UnknownName,
                                format!("unknown infer evidence tool '{tool}'"),
                                tool_expr.span(),
                            ));
                        }
                        names.push(tool.to_string());
                    }
                    tools = Some(names);
                }
                "task" => {
                    if has_task {
                        return Err(diag(
                            DiagnosticCode::DuplicateName,
                            "infer contains more than one task",
                            argument.span(),
                        ));
                    }
                    has_task = true;
                    data.push(argument.clone());
                }
                _ => data.push(argument.clone()),
            }
        }
        if !has_task {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "infer requires (task EXPR)",
                span,
            ));
        }
        let Some(result) = result else {
            return Err(diag(
                DiagnosticCode::InvalidType,
                "typed infer requires (returns TYPE)",
                span,
            ));
        };
        self.validate_type_names(&result, span)?;
        let named = self.analyze_named_arguments(&data, scope, depth + 1)?;
        require_pure_all(
            named.iter().flat_map(|argument| argument.values.iter()),
            "infer arguments",
        )?;
        let mut effects = union_effects(named.iter().flat_map(|argument| argument.values.iter()));
        if !root_model_owned {
            effects.insert(Effect::Infer);
        }
        if let Some(tool_names) = &tools {
            for tool in tool_names {
                effects.insert(Effect::Tool(tool.clone()));
            }
        }
        Ok(hir(
            HirKind::Infer {
                arguments: named,
                tools,
                result: result.clone(),
            },
            result,
            effects,
            span,
        ))
    }

    fn analyze_par(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        if arguments.len() < 2 {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "par requires at least two branches",
                span,
            ));
        }
        if arguments.len() > self.limits.max_par_branches {
            return Err(diag(
                DiagnosticCode::ResourceLimit,
                format!(
                    "par contains {} branches; the limit is {}",
                    arguments.len(),
                    self.limits.max_par_branches
                ),
                span,
            ));
        }
        let mut names = HashSet::new();
        let mut branches = Vec::new();
        let mut fields = BTreeMap::new();
        for branch in arguments {
            let items = expect_list(branch, "par members must be (branch NAME EXPR)")?;
            let [tag, name, body] = items else {
                return Err(diag(
                    DiagnosticCode::TypeMismatch,
                    "par members must be (branch NAME EXPR)",
                    branch.span(),
                ));
            };
            if tag.as_symbol() != Some("branch") {
                return Err(diag(
                    DiagnosticCode::UnknownOperator,
                    "par members must start with branch",
                    tag.span(),
                ));
            }
            let name = expect_symbol(name, "branch name must be a symbol")?;
            if !is_identifier(name) {
                return Err(diag(
                    DiagnosticCode::UnknownName,
                    format!("invalid branch name '{name}'"),
                    items[1].span(),
                ));
            }
            if !names.insert(name.to_string()) {
                return Err(diag(
                    DiagnosticCode::DuplicateName,
                    format!("duplicate par branch '{name}'"),
                    items[1].span(),
                ));
            }
            let body = self.analyze_expr(body, &mut scope.clone(), depth + 1)?;
            fields.insert(name.to_string(), body.ty.clone());
            branches.push(ParBranch {
                name: name.to_string(),
                body,
                span: branch.span(),
            });
        }
        Ok(hir(
            HirKind::Par {
                branches: branches.clone(),
            },
            Type::StructuralRecord(fields),
            union_effects(branches.iter().map(|branch| &branch.body)),
            span,
        ))
    }

    fn analyze_run(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let [program] = arguments else {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "run requires one Program Value",
                span,
            ));
        };
        let program = self.analyze_expr(program, scope, depth + 1)?;
        require_pure(&program, "run operand")?;
        let Type::Program { output, effects } = &program.ty else {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "run operand must have Program<T, E> type",
                program.span,
            ));
        };
        let output = *output.clone();
        let effects = effects.clone();
        let mut run_effects = program.effects.clone();
        run_effects.insert(Effect::Program(Box::new(effects)));
        Ok(hir(
            HirKind::Run {
                program: Box::new(program),
            },
            output,
            run_effects,
            span,
        ))
    }

    fn analyze_host(
        &mut self,
        operation: &str,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let Some(signature) = self.profile.host_signature(operation) else {
            return Err(diag(
                DiagnosticCode::UnknownName,
                format!("unknown host operation '{operation}'"),
                span,
            ));
        };
        let named = self.analyze_named_arguments(arguments, scope, depth + 1)?;
        require_pure_all(
            named.iter().flat_map(|argument| argument.values.iter()),
            "host operation arguments",
        )?;
        self.check_signature(&named, &signature, span)?;
        let mut effects = union_effects(named.iter().flat_map(|argument| argument.values.iter()));
        effects.insert(Effect::Host(operation.to_string()));
        Ok(hir(
            HirKind::Host {
                operation: operation.to_string(),
                arguments: named,
            },
            signature.result,
            effects,
            span,
        ))
    }

    fn analyze_host_unary(
        &mut self,
        operation: &str,
        argument_name: &str,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let [argument] = arguments else {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                format!("{operation} requires exactly one operand"),
                span,
            ));
        };
        let Some(signature) = self.profile.host_signature(operation) else {
            return Err(diag(
                DiagnosticCode::UnknownName,
                format!("unknown host operation '{operation}'"),
                span,
            ));
        };
        let value = self.analyze_expr(argument, scope, depth + 1)?;
        require_pure(&value, "host operation operand")?;
        let named = vec![NamedArgument {
            name: argument_name.to_string(),
            values: vec![value],
            span: argument.span(),
        }];
        self.check_signature(&named, &signature, span)?;
        Ok(hir(
            HirKind::Host {
                operation: operation.to_string(),
                arguments: named,
            },
            signature.result,
            EffectSet::new([Effect::Host(operation.to_string())]),
            span,
        ))
    }

    fn analyze_host_view(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let [reference, returns] = arguments else {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "host.view requires REF and (returns TYPE)",
                span,
            ));
        };
        let reference = self.analyze_expr(reference, scope, depth + 1)?;
        require_pure(&reference, "host.view reference")?;
        let Type::Ref(kind) = &reference.ty else {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "host.view first operand must be Ref<K>",
                reference.span,
            ));
        };
        if let Some(objects) = &self.requirements.objects {
            if !objects.contains(kind) {
                return Err(diag(
                    DiagnosticCode::EffectEscape,
                    format!(
                        "host.view Ref<{kind}> exceeds declared object upper bound {:?}",
                        objects
                    ),
                    reference.span,
                ));
            }
        }
        let return_items = expect_list(returns, "host.view result must be (returns TYPE)")?;
        let [tag, result] = return_items else {
            return Err(diag(
                DiagnosticCode::InvalidType,
                "host.view result must be (returns TYPE)",
                returns.span(),
            ));
        };
        if tag.as_symbol() != Some("returns") {
            return Err(diag(
                DiagnosticCode::InvalidType,
                "host.view second operand must be (returns TYPE)",
                returns.span(),
            ));
        }
        let result = self.parse_type(result)?;
        self.validate_type_names(&result, returns.span())?;
        let projection_type = match &result {
            Type::Json | Type::StructuralRecord(_) => true,
            Type::Named(name) => matches!(
                self.definitions.get(name),
                Some(TypeDefinition::Record { .. })
            ),
            _ => false,
        };
        if !projection_type {
            return Err(diag(
                DiagnosticCode::InvalidType,
                "host.view return type must be Json, a structural record, or a named record",
                returns.span(),
            ));
        }
        let effect = Effect::Host(format!("view.{kind}"));
        Ok(hir(
            HirKind::Host {
                operation: "host.view".to_string(),
                arguments: vec![NamedArgument {
                    name: "ref".to_string(),
                    values: vec![reference],
                    span: arguments[0].span(),
                }],
            },
            result,
            EffectSet::new([effect]),
            span,
        ))
    }

    fn analyze_match(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        span: SourceSpan,
        depth: usize,
    ) -> Result<HirExpr, Diagnostic> {
        let Some(value_expr) = arguments.first() else {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "match requires a value and cases",
                span,
            ));
        };
        let value = self.analyze_expr(value_expr, scope, depth + 1)?;
        require_pure(&value, "match value")?;
        let Type::Named(type_name) = &value.ty else {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "match value must be a named union",
                value.span,
            ));
        };
        let Some(TypeDefinition::Union { variants, .. }) = self.definitions.get(type_name).cloned()
        else {
            return Err(diag(
                DiagnosticCode::InvalidType,
                format!("'{type_name}' is not a union"),
                value.span,
            ));
        };
        let mut cases = Vec::new();
        let mut seen = HashSet::new();
        for case_expr in &arguments[1..] {
            let case_items = expect_list(case_expr, "match case must be (PATTERN BODY)")?;
            let [pattern, body_expr] = case_items else {
                return Err(diag(
                    DiagnosticCode::TypeMismatch,
                    "match case must contain pattern and body",
                    case_expr.span(),
                ));
            };
            let pattern_items =
                expect_list(pattern, "match pattern must be (case TYPE.VARIANT ...)")?;
            if pattern_items.first().and_then(Expr::as_symbol) != Some("case")
                || pattern_items.len() < 2
            {
                return Err(diag(
                    DiagnosticCode::TypeMismatch,
                    "match pattern must start with (case TYPE.VARIANT ...)",
                    pattern.span(),
                ));
            }
            let constructor =
                expect_symbol(&pattern_items[1], "match constructor must be TYPE.VARIANT")?;
            let Some((case_type, variant_name)) = constructor.rsplit_once('.') else {
                return Err(diag(
                    DiagnosticCode::InvalidType,
                    "match constructor must be TYPE.VARIANT",
                    pattern_items[1].span(),
                ));
            };
            if case_type != type_name {
                return Err(diag(
                    DiagnosticCode::TypeMismatch,
                    format!("case for '{case_type}' cannot match '{type_name}'"),
                    pattern_items[1].span(),
                ));
            }
            if !seen.insert(variant_name.to_string()) {
                return Err(diag(
                    DiagnosticCode::DuplicateName,
                    format!("duplicate match case '{variant_name}'"),
                    pattern_items[1].span(),
                ));
            }
            let Some(variant) = variants.iter().find(|item| item.name == variant_name) else {
                return Err(diag(
                    DiagnosticCode::InvalidType,
                    format!("unknown variant '{type_name}.{variant_name}'"),
                    pattern_items[1].span(),
                ));
            };
            let mut case_scope = scope.clone();
            let bindings =
                self.parse_match_bindings(&pattern_items[2..], &variant.fields, &mut case_scope)?;
            let body = self.analyze_expr(body_expr, &mut case_scope, depth + 1)?;
            cases.push(MatchCase {
                variant: variant_name.to_string(),
                bindings,
                body,
                span: case_expr.span(),
            });
        }
        let missing = variants
            .iter()
            .filter(|variant| !seen.contains(&variant.name))
            .map(|variant| variant.name.clone())
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                format!("non-exhaustive match; missing {}", missing.join(", ")),
                span,
            ));
        }
        let ty = common_types(cases.iter().map(|case| &case.body.ty), span)?
            .ok_or_else(|| diag(DiagnosticCode::TypeMismatch, "match has no cases", span))?;
        let effects = value
            .effects
            .union(&union_effects(cases.iter().map(|case| &case.body)));
        Ok(hir(
            HirKind::Match {
                value: Box::new(value),
                cases,
            },
            ty,
            effects,
            span,
        ))
    }

    fn analyze_many(
        &mut self,
        expressions: &[Expr],
        scope: &mut Scope,
        depth: usize,
    ) -> Result<Vec<HirExpr>, Diagnostic> {
        expressions
            .iter()
            .map(|expression| self.analyze_expr(expression, scope, depth))
            .collect()
    }

    fn analyze_named_arguments(
        &mut self,
        arguments: &[Expr],
        scope: &mut Scope,
        depth: usize,
    ) -> Result<Vec<NamedArgument>, Diagnostic> {
        let mut seen = HashSet::new();
        let mut output = Vec::new();
        for argument in arguments {
            let items = expect_list(argument, "named argument must be (NAME EXPR...)")?;
            let Some(name_expr) = items.first() else {
                return Err(diag(
                    DiagnosticCode::TypeMismatch,
                    "named argument is empty",
                    argument.span(),
                ));
            };
            let name = expect_symbol(name_expr, "argument name must be a symbol")?;
            if items.len() < 2 {
                return Err(diag(
                    DiagnosticCode::TypeMismatch,
                    format!("argument '{name}' has no value"),
                    argument.span(),
                ));
            }
            if !seen.insert(name.to_string()) {
                return Err(diag(
                    DiagnosticCode::DuplicateName,
                    format!("duplicate argument '{name}'"),
                    name_expr.span(),
                ));
            }
            output.push(NamedArgument {
                name: name.to_string(),
                values: self.analyze_many(&items[1..], scope, depth)?,
                span: argument.span(),
            });
        }
        Ok(output)
    }

    fn analyze_named_fields(
        &mut self,
        arguments: &[Expr],
        definitions: &[FieldDefinition],
        scope: &mut Scope,
        depth: usize,
    ) -> Result<Vec<(String, HirExpr)>, Diagnostic> {
        if arguments.len() != definitions.len() {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                format!(
                    "constructor requires {} fields, received {}",
                    definitions.len(),
                    arguments.len()
                ),
                arguments.first().map_or_else(
                    || definitions.first().map_or_else(empty_span, |v| v.span),
                    Expr::span,
                ),
            ));
        }
        let mut seen = HashSet::new();
        let mut values = Vec::new();
        for argument in arguments {
            let items = expect_list(argument, "field value must be (FIELD EXPR)")?;
            let [name_expr, value_expr] = items else {
                return Err(diag(
                    DiagnosticCode::TypeMismatch,
                    "field value must contain exactly FIELD and EXPR",
                    argument.span(),
                ));
            };
            let name = expect_symbol(name_expr, "field name must be a symbol")?;
            if !seen.insert(name.to_string()) {
                return Err(diag(
                    DiagnosticCode::DuplicateName,
                    format!("duplicate field '{name}'"),
                    name_expr.span(),
                ));
            }
            let Some(definition) = definitions.iter().find(|field| field.name == name) else {
                return Err(diag(
                    DiagnosticCode::UnknownName,
                    format!("unknown field '{name}'"),
                    name_expr.span(),
                ));
            };
            let value = self.analyze_expr(value_expr, scope, depth)?;
            require_assignable(&value.ty, &definition.ty, value.span)?;
            values.push((name.to_string(), value));
        }
        for definition in definitions {
            if !seen.contains(&definition.name) {
                return Err(diag(
                    DiagnosticCode::TypeMismatch,
                    format!("missing field '{}'", definition.name),
                    definition.span,
                ));
            }
        }
        Ok(values)
    }

    fn parse_match_bindings(
        &self,
        expressions: &[Expr],
        fields: &[FieldDefinition],
        scope: &mut Scope,
    ) -> Result<Vec<MatchBinding>, Diagnostic> {
        if expressions.len() != fields.len() {
            return Err(diag(
                DiagnosticCode::TypeMismatch,
                "match pattern must bind every variant field exactly once",
                expressions.first().map_or_else(empty_span, Expr::span),
            ));
        }
        let mut seen_fields = HashSet::new();
        let mut bindings = Vec::new();
        for expression in expressions {
            let items = expect_list(expression, "match field binding must be (FIELD NAME)")?;
            let [field_expr, binding_expr] = items else {
                return Err(diag(
                    DiagnosticCode::TypeMismatch,
                    "match field binding must contain FIELD and NAME",
                    expression.span(),
                ));
            };
            let field = expect_symbol(field_expr, "match field must be a symbol")?;
            let binding = expect_binding_name(binding_expr)?;
            let Some(definition) = fields.iter().find(|value| value.name == field) else {
                return Err(diag(
                    DiagnosticCode::UnknownName,
                    format!("variant has no field '{field}'"),
                    field_expr.span(),
                ));
            };
            if !seen_fields.insert(field.to_string()) {
                return Err(diag(
                    DiagnosticCode::DuplicateName,
                    format!("match repeats field '{field}'"),
                    field_expr.span(),
                ));
            }
            if scope
                .bindings
                .insert(binding.to_string(), definition.ty.clone())
                .is_some()
            {
                return Err(diag(
                    DiagnosticCode::DuplicateName,
                    format!("match binding '{binding}' shadows an existing binding"),
                    binding_expr.span(),
                ));
            }
            bindings.push(MatchBinding {
                field: field.to_string(),
                binding: binding.to_string(),
            });
        }
        Ok(bindings)
    }

    fn check_signature(
        &self,
        arguments: &[NamedArgument],
        signature: &ToolSignature,
        span: SourceSpan,
    ) -> Result<(), Diagnostic> {
        if signature.arguments.is_empty() && signature.required.is_empty() {
            return Ok(());
        }
        let names = arguments
            .iter()
            .map(|argument| argument.name.as_str())
            .collect::<HashSet<_>>();
        for required in &signature.required {
            if !names.contains(required.as_str()) {
                return Err(diag(
                    DiagnosticCode::TypeMismatch,
                    format!("missing required argument '{required}'"),
                    span,
                ));
            }
        }
        for argument in arguments {
            let Some(expected) = signature.arguments.get(&argument.name) else {
                return Err(diag(
                    DiagnosticCode::UnknownName,
                    format!("unknown argument '{}'", argument.name),
                    argument.span,
                ));
            };
            let actual = if argument.values.len() == 1 {
                argument.values[0].ty.clone()
            } else {
                Type::List(Box::new(
                    common_types(argument.values.iter().map(|value| &value.ty), argument.span)?
                        .unwrap_or(Type::Json),
                ))
            };
            require_assignable(&actual, expected, argument.span)?;
        }
        Ok(())
    }

    fn parse_requirements(&self, expression: &Expr) -> Result<Requirements, Diagnostic> {
        let items = expect_list(expression, "requires must be a list")?;
        let mut output = Requirements::default();
        for clause in &items[1..] {
            let fields = expect_list(clause, "requires clauses must be lists")?;
            let Some(name) = fields.first().and_then(Expr::as_symbol) else {
                return Err(diag(
                    DiagnosticCode::UnknownName,
                    "requires clause has no name",
                    clause.span(),
                ));
            };
            match name {
                "tools" => {
                    if output.tools.is_some() {
                        return Err(duplicate_declaration("tools", clause.span()));
                    }
                    output.tools = Some(parse_symbol_set(&fields[1..], "tool")?);
                }
                "objects" => {
                    if output.objects.is_some() {
                        return Err(duplicate_declaration("objects", clause.span()));
                    }
                    output.objects = Some(parse_symbol_set(&fields[1..], "object kind")?);
                }
                "effects" => {
                    if output.effects.is_some() {
                        return Err(duplicate_declaration("effects", clause.span()));
                    }
                    output.effects = Some(self.parse_effects(&fields[1..])?);
                }
                other => {
                    return Err(diag(
                        DiagnosticCode::UnknownName,
                        format!("unknown requires clause '{other}'"),
                        fields[0].span(),
                    ))
                }
            }
        }
        Ok(output)
    }

    fn parse_type_definitions(
        &self,
        expression: &Expr,
    ) -> Result<BTreeMap<String, TypeDefinition>, Diagnostic> {
        let items = expect_list(expression, "types must be a list")?;
        let mut output = BTreeMap::new();
        for declaration in &items[1..] {
            let parts = expect_list(declaration, "type declaration must be a list")?;
            let Some(kind) = parts.first().and_then(Expr::as_symbol) else {
                return Err(diag(
                    DiagnosticCode::InvalidType,
                    "type declaration has no kind",
                    declaration.span(),
                ));
            };
            let Some(name_expr) = parts.get(1) else {
                return Err(diag(
                    DiagnosticCode::InvalidType,
                    "type declaration has no name",
                    declaration.span(),
                ));
            };
            let name = expect_symbol(name_expr, "type name must be a symbol")?;
            if is_builtin_type(name) || !is_identifier(name) {
                return Err(diag(
                    DiagnosticCode::InvalidType,
                    format!("invalid or reserved type name '{name}'"),
                    name_expr.span(),
                ));
            }
            if output.contains_key(name) {
                return Err(diag(
                    DiagnosticCode::DuplicateName,
                    format!("duplicate type '{name}'"),
                    name_expr.span(),
                ));
            }
            let definition = match kind {
                "record" => TypeDefinition::Record {
                    name: name.to_string(),
                    fields: self.parse_field_definitions(&parts[2..])?,
                    span: declaration.span(),
                },
                "union" => {
                    let mut variants = Vec::new();
                    let mut names = HashSet::new();
                    for variant_expr in &parts[2..] {
                        let variant_parts =
                            expect_list(variant_expr, "union variant must be a list")?;
                        let Some(variant_name_expr) = variant_parts.first() else {
                            return Err(diag(
                                DiagnosticCode::InvalidType,
                                "union variant has no name",
                                variant_expr.span(),
                            ));
                        };
                        let variant_name = expect_symbol(
                            variant_name_expr,
                            "union variant name must be a symbol",
                        )?;
                        if !is_identifier(variant_name) || !names.insert(variant_name.to_string()) {
                            return Err(diag(
                                DiagnosticCode::DuplicateName,
                                format!("invalid or duplicate union variant '{variant_name}'"),
                                variant_name_expr.span(),
                            ));
                        }
                        variants.push(VariantDefinition {
                            name: variant_name.to_string(),
                            fields: self.parse_field_definitions(&variant_parts[1..])?,
                            span: variant_expr.span(),
                        });
                    }
                    if variants.is_empty() {
                        return Err(diag(
                            DiagnosticCode::InvalidType,
                            format!("union '{name}' must define at least one variant"),
                            declaration.span(),
                        ));
                    }
                    TypeDefinition::Union {
                        name: name.to_string(),
                        variants,
                        span: declaration.span(),
                    }
                }
                other => {
                    return Err(diag(
                        DiagnosticCode::InvalidType,
                        format!("unknown type declaration kind '{other}'"),
                        parts[0].span(),
                    ))
                }
            };
            output.insert(name.to_string(), definition);
        }
        Ok(output)
    }

    fn parse_field_definitions(
        &self,
        expressions: &[Expr],
    ) -> Result<Vec<FieldDefinition>, Diagnostic> {
        if expressions.len() > self.limits.max_fields {
            return Err(resource_fields(
                expressions.len(),
                self.limits.max_fields,
                expressions.first().map_or_else(empty_span, Expr::span),
            ));
        }
        let mut output = Vec::new();
        let mut names = HashSet::new();
        for expression in expressions {
            let items = expect_list(expression, "field definition must be (NAME TYPE)")?;
            let [name_expr, type_expr] = items else {
                return Err(diag(
                    DiagnosticCode::InvalidType,
                    "field definition must contain NAME and TYPE",
                    expression.span(),
                ));
            };
            let name = expect_symbol(name_expr, "field name must be a symbol")?;
            if !is_identifier(name) || !names.insert(name.to_string()) {
                return Err(diag(
                    DiagnosticCode::DuplicateName,
                    format!("invalid or duplicate field '{name}'"),
                    name_expr.span(),
                ));
            }
            output.push(FieldDefinition {
                name: name.to_string(),
                ty: self.parse_type(type_expr)?,
                span: expression.span(),
            });
        }
        Ok(output)
    }

    fn validate_type_definitions(&self) -> Result<(), Diagnostic> {
        for definition in self.definitions.values() {
            for ty in definition_types(definition) {
                self.validate_type_names(ty, definition.span())?;
            }
        }
        for name in self.definitions.keys() {
            let mut visiting = HashSet::new();
            let mut visited = HashSet::new();
            if self.type_reaches(name, name, &mut visiting, &mut visited) {
                let definition = &self.definitions[name];
                return Err(diag(
                    DiagnosticCode::RecursiveType,
                    format!("recursive type '{name}' is not supported in Yao v0.1"),
                    definition.span(),
                ));
            }
        }
        Ok(())
    }

    fn validate_type_names(&self, ty: &Type, span: SourceSpan) -> Result<(), Diagnostic> {
        match ty {
            Type::Named(name) if !self.definitions.contains_key(name) => Err(diag(
                DiagnosticCode::InvalidType,
                format!("unknown type '{name}'"),
                span,
            )),
            Type::List(inner) | Type::Map(inner) | Type::Option(inner) => {
                self.validate_type_names(inner, span)
            }
            Type::StructuralRecord(fields) => {
                for value in fields.values() {
                    self.validate_type_names(value, span)?;
                }
                Ok(())
            }
            Type::Result { ok, error } => {
                self.validate_type_names(ok, span)?;
                self.validate_type_names(error, span)
            }
            Type::Program { output, .. } => self.validate_type_names(output, span),
            _ => Ok(()),
        }
    }

    fn contains_nonforgeable_type(&self, ty: &Type, visiting: &mut HashSet<String>) -> bool {
        match ty {
            Type::EvidenceCandidate
            | Type::OutcomeCandidate
            | Type::ContextTransaction
            | Type::Ref(_)
            | Type::Program { .. } => true,
            Type::List(inner) | Type::Map(inner) | Type::Option(inner) => {
                self.contains_nonforgeable_type(inner, visiting)
            }
            Type::StructuralRecord(fields) => fields
                .values()
                .any(|field| self.contains_nonforgeable_type(field, visiting)),
            Type::Result { ok, error } => {
                self.contains_nonforgeable_type(ok, visiting)
                    || self.contains_nonforgeable_type(error, visiting)
            }
            Type::Named(name) => {
                if !visiting.insert(name.clone()) {
                    return false;
                }
                let found = self.definitions.get(name).is_some_and(|definition| {
                    definition_types(definition)
                        .any(|field| self.contains_nonforgeable_type(field, visiting))
                });
                visiting.remove(name);
                found
            }
            _ => false,
        }
    }

    fn type_reaches(
        &self,
        start: &str,
        current: &str,
        visiting: &mut HashSet<String>,
        visited: &mut HashSet<String>,
    ) -> bool {
        if !visiting.insert(current.to_string()) {
            return false;
        }
        let Some(definition) = self.definitions.get(current) else {
            return false;
        };
        for dependency in definition_types(definition).flat_map(named_dependencies) {
            if dependency == start {
                return true;
            }
            if !visited.contains(&dependency)
                && self.type_reaches(start, &dependency, visiting, visited)
            {
                return true;
            }
        }
        visiting.remove(current);
        visited.insert(current.to_string());
        false
    }

    fn parse_type(&self, expression: &Expr) -> Result<Type, Diagnostic> {
        if let Some(name) = expression.as_symbol() {
            return Ok(match name {
                "Nil" => Type::Nil,
                "Bool" => Type::Bool,
                "Int" => Type::Int,
                "Float" => Type::Float,
                "String" => Type::String,
                "Bytes" => Type::Bytes,
                "Json" => Type::Json,
                "EvidenceCandidate" => Type::EvidenceCandidate,
                "OutcomeCandidate" => Type::OutcomeCandidate,
                "ContextTransaction" => Type::ContextTransaction,
                other if is_identifier(other) => Type::Named(other.to_string()),
                other => {
                    return Err(diag(
                        DiagnosticCode::InvalidType,
                        format!("invalid type '{other}'"),
                        expression.span(),
                    ))
                }
            });
        }
        let items = expect_list(expression, "type must be a symbol or parameterized list")?;
        let Some(constructor) = items.first().and_then(Expr::as_symbol) else {
            return Err(diag(
                DiagnosticCode::InvalidType,
                "parameterized type has no constructor",
                expression.span(),
            ));
        };
        match constructor {
            "List" | "Map" | "Option" | "Ref" => {
                let [_, inner] = items else {
                    return Err(diag(
                        DiagnosticCode::InvalidType,
                        format!("{constructor} requires one type argument"),
                        expression.span(),
                    ));
                };
                if constructor == "Ref" {
                    let kind = expect_symbol(inner, "Ref kind must be a symbol")?;
                    Ok(Type::Ref(kind.to_string()))
                } else {
                    let inner = Box::new(self.parse_type(inner)?);
                    Ok(match constructor {
                        "List" => Type::List(inner),
                        "Map" => Type::Map(inner),
                        "Option" => Type::Option(inner),
                        _ => unreachable!(),
                    })
                }
            }
            "Result" => {
                let [_, ok, error] = items else {
                    return Err(diag(
                        DiagnosticCode::InvalidType,
                        "Result requires success and error types",
                        expression.span(),
                    ));
                };
                Ok(Type::Result {
                    ok: Box::new(self.parse_type(ok)?),
                    error: Box::new(self.parse_type(error)?),
                })
            }
            "Program" => {
                let [_, output, effects] = items else {
                    return Err(diag(
                        DiagnosticCode::InvalidType,
                        "Program requires output type and (effects ...)",
                        expression.span(),
                    ));
                };
                let effect_items = expect_list(effects, "Program effects must be a list")?;
                if effect_items.first().and_then(Expr::as_symbol) != Some("effects") {
                    return Err(diag(
                        DiagnosticCode::InvalidType,
                        "Program second argument must be (effects ...)",
                        effects.span(),
                    ));
                }
                Ok(Type::Program {
                    output: Box::new(self.parse_type(output)?),
                    effects: self.parse_effects(&effect_items[1..])?,
                })
            }
            other => Err(diag(
                DiagnosticCode::InvalidType,
                format!("unknown type constructor '{other}'"),
                items[0].span(),
            )),
        }
    }

    fn parse_infer_result(&self, expression: &Expr) -> Result<Type, Diagnostic> {
        self.parse_type(expression)
    }

    fn parse_effects(&self, expressions: &[Expr]) -> Result<EffectSet, Diagnostic> {
        let mut effects = EffectSet::default();
        for expression in expressions {
            let effect = if expression.as_symbol() == Some("infer") {
                Effect::Infer
            } else {
                let items = expect_list(expression, "effect must be infer or a list")?;
                let Some(kind) = items.first().and_then(Expr::as_symbol) else {
                    return Err(diag(
                        DiagnosticCode::InvalidType,
                        "effect list has no kind",
                        expression.span(),
                    ));
                };
                match kind {
                    "tool" | "host" => {
                        let [_, name] = items else {
                            return Err(diag(
                                DiagnosticCode::InvalidType,
                                format!("{kind} effect requires one name"),
                                expression.span(),
                            ));
                        };
                        let name = expect_symbol(name, "effect name must be a symbol")?;
                        if kind == "tool" {
                            Effect::Tool(name.to_string())
                        } else {
                            Effect::Host(name.to_string())
                        }
                    }
                    "program" => Effect::Program(Box::new(self.parse_effects(&items[1..])?)),
                    other => {
                        return Err(diag(
                            DiagnosticCode::InvalidType,
                            format!("unknown effect kind '{other}'"),
                            items[0].span(),
                        ))
                    }
                }
            };
            if !effects.insert(effect) {
                return Err(diag(
                    DiagnosticCode::DuplicateName,
                    "duplicate effect declaration",
                    expression.span(),
                ));
            }
        }
        Ok(effects)
    }

    fn field_type(&self, ty: &Type, field: &str, span: SourceSpan) -> Result<Type, Diagnostic> {
        match ty {
            Type::StructuralRecord(fields) => fields.get(field).cloned(),
            Type::Named(name) => match self.definitions.get(name) {
                Some(TypeDefinition::Record { fields, .. }) => fields
                    .iter()
                    .find(|definition| definition.name == field)
                    .map(|definition| definition.ty.clone()),
                _ => None,
            },
            _ => None,
        }
        .ok_or_else(|| {
            diag(
                DiagnosticCode::TypeMismatch,
                format!("type {ty:?} has no readable field '{field}'"),
                span,
            )
        })
    }
}

fn hir(kind: HirKind, ty: Type, effects: EffectSet, span: SourceSpan) -> HirExpr {
    HirExpr {
        kind,
        ty,
        effects,
        span,
    }
}

fn diag(code: DiagnosticCode, message: impl Into<String>, span: SourceSpan) -> Diagnostic {
    Diagnostic::new(code, message, span)
}

fn expect_list<'a>(expression: &'a Expr, message: &str) -> Result<&'a [Expr], Diagnostic> {
    expression
        .as_list()
        .ok_or_else(|| diag(DiagnosticCode::TypeMismatch, message, expression.span()))
}

fn expect_symbol<'a>(expression: &'a Expr, message: &str) -> Result<&'a str, Diagnostic> {
    expression
        .as_symbol()
        .ok_or_else(|| diag(DiagnosticCode::UnknownName, message, expression.span()))
}

fn atom_text<'a>(expression: &'a Expr, message: &str) -> Result<&'a str, Diagnostic> {
    match expression {
        Expr::Atom(atom) => Ok(&atom.value),
        _ => Err(diag(
            DiagnosticCode::TypeMismatch,
            message,
            expression.span(),
        )),
    }
}

fn expect_binding_name(expression: &Expr) -> Result<&str, Diagnostic> {
    let name = expect_symbol(expression, "binding name must be a symbol without '$'")?;
    if name.starts_with('$') || !is_identifier(name) {
        return Err(diag(
            DiagnosticCode::UnknownName,
            format!("invalid binding name '{name}'"),
            expression.span(),
        ));
    }
    Ok(name)
}

fn is_form(expression: Option<&Expr>, name: &str) -> bool {
    expression
        .and_then(Expr::as_list)
        .and_then(|items| items.first())
        .and_then(Expr::as_symbol)
        == Some(name)
}

fn is_identifier(value: &str) -> bool {
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    (first.is_alphabetic() || first == '_')
        && characters.all(|value| value.is_alphanumeric() || matches!(value, '_' | '-'))
}

fn is_builtin_type(value: &str) -> bool {
    matches!(
        value,
        "Nil"
            | "Bool"
            | "Int"
            | "Float"
            | "String"
            | "Bytes"
            | "Json"
            | "List"
            | "Map"
            | "Option"
            | "Result"
            | "Ref"
            | "Program"
            | "EvidenceCandidate"
            | "OutcomeCandidate"
            | "ContextTransaction"
    )
}

fn looks_like_float_literal(value: &str) -> bool {
    let unsigned = value
        .strip_prefix('-')
        .or_else(|| value.strip_prefix('+'))
        .unwrap_or(value);
    let starts_numeric = unsigned
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_digit() || character == '.');

    starts_numeric && (value.contains('.') || value.contains('e') || value.contains('E'))
}

fn parse_symbol_set(
    expressions: &[Expr],
    description: &str,
) -> Result<BTreeSet<String>, Diagnostic> {
    let mut output = BTreeSet::new();
    for expression in expressions {
        let name = expect_symbol(expression, &format!("{description} must be a symbol"))?;
        if !output.insert(name.to_string()) {
            return Err(diag(
                DiagnosticCode::DuplicateName,
                format!("duplicate {description} '{name}'"),
                expression.span(),
            ));
        }
    }
    Ok(output)
}

fn duplicate_declaration(name: &str, span: SourceSpan) -> Diagnostic {
    diag(
        DiagnosticCode::DuplicateName,
        format!("duplicate requires.{name} declaration"),
        span,
    )
}

fn definition_types(definition: &TypeDefinition) -> impl Iterator<Item = &Type> {
    let values: Vec<&Type> = match definition {
        TypeDefinition::Record { fields, .. } => fields.iter().map(|field| &field.ty).collect(),
        TypeDefinition::Union { variants, .. } => variants
            .iter()
            .flat_map(|variant| variant.fields.iter().map(|field| &field.ty))
            .collect(),
    };
    values.into_iter()
}

fn named_dependencies(ty: &Type) -> Vec<String> {
    let mut output = Vec::new();
    collect_named_dependencies(ty, &mut output);
    output
}

fn collect_named_dependencies(ty: &Type, output: &mut Vec<String>) {
    match ty {
        Type::Named(name) => output.push(name.clone()),
        Type::List(inner) | Type::Map(inner) | Type::Option(inner) => {
            collect_named_dependencies(inner, output)
        }
        Type::StructuralRecord(fields) => {
            for value in fields.values() {
                collect_named_dependencies(value, output);
            }
        }
        Type::Result { ok, error } => {
            collect_named_dependencies(ok, output);
            collect_named_dependencies(error, output);
        }
        Type::Program { output: value, .. } => collect_named_dependencies(value, output),
        _ => {}
    }
}

fn union_effects<'a>(expressions: impl IntoIterator<Item = &'a HirExpr>) -> EffectSet {
    expressions
        .into_iter()
        .fold(EffectSet::default(), |effects, expression| {
            effects.union(&expression.effects)
        })
}

fn common_types<'a>(
    mut types: impl Iterator<Item = &'a Type>,
    span: SourceSpan,
) -> Result<Option<Type>, Diagnostic> {
    let Some(first) = types.next() else {
        return Ok(None);
    };
    let mut current = first.clone();
    for next in types {
        current = common_type(&current, next).ok_or_else(|| {
            diag(
                DiagnosticCode::TypeMismatch,
                format!("types {current:?} and {next:?} have no common type"),
                span,
            )
        })?;
    }
    Ok(Some(current))
}

fn infer_dict_value_type(entries: &[(String, HirExpr)]) -> Result<Option<Type>, Diagnostic> {
    let Some((_, first)) = entries.first() else {
        return Ok(None);
    };
    let mut current = first.ty.clone();
    let mut representative_span = first.span;
    for (key, value) in &entries[1..] {
        let Some(common) = common_type(&current, &value.ty) else {
            return Err(
                diag(
                    DiagnosticCode::TypeMismatch,
                    format!(
                        "dict field '{key}' has type {:?}, which has no common type with the inferred value type {current:?}; dict is a homogeneous Map<T>, so use a named record for fixed heterogeneous fields or an explicit Json boundary for dynamic data",
                        value.ty
                    ),
                    value.span,
                )
                .with_related(representative_span),
            );
        };
        if common != current {
            current = common;
            representative_span = value.span;
        }
    }
    Ok(Some(current))
}

fn common_type(left: &Type, right: &Type) -> Option<Type> {
    if left.is_assignable_to(right) {
        Some(right.clone())
    } else if right.is_assignable_to(left) {
        Some(left.clone())
    } else {
        None
    }
}

fn require_assignable(actual: &Type, expected: &Type, span: SourceSpan) -> Result<(), Diagnostic> {
    if actual.is_assignable_to(expected) {
        Ok(())
    } else {
        Err(diag(
            DiagnosticCode::TypeMismatch,
            format!("expected {expected:?}, found {actual:?}"),
            span,
        ))
    }
}

fn require_arity(
    name: &str,
    operands: &[HirExpr],
    expected: usize,
    span: SourceSpan,
) -> Result<(), Diagnostic> {
    if operands.len() == expected {
        Ok(())
    } else {
        Err(diag(
            DiagnosticCode::TypeMismatch,
            format!(
                "{name} requires {expected} operands, found {}",
                operands.len()
            ),
            span,
        ))
    }
}

fn require_comparable(left: &Type, right: &Type, span: SourceSpan) -> Result<(), Diagnostic> {
    let comparable = matches!(
        (left, right),
        (Type::Int, Type::Int)
            | (Type::Int, Type::Float)
            | (Type::Float, Type::Int)
            | (Type::Float, Type::Float)
            | (Type::String, Type::String)
    );
    if comparable {
        Ok(())
    } else {
        Err(diag(
            DiagnosticCode::TypeMismatch,
            format!("types {left:?} and {right:?} are not ordered"),
            span,
        ))
    }
}

fn numeric_result(operands: &[HirExpr], span: SourceSpan) -> Result<Type, Diagnostic> {
    let mut result = Type::Int;
    for operand in operands {
        match operand.ty {
            Type::Int => {}
            Type::Float => result = Type::Float,
            _ => {
                return Err(diag(
                    DiagnosticCode::TypeMismatch,
                    format!("numeric operator received {:?}", operand.ty),
                    span,
                ))
            }
        }
    }
    Ok(result)
}

fn resource_fields(actual: usize, limit: usize, span: SourceSpan) -> Diagnostic {
    diag(
        DiagnosticCode::ResourceLimit,
        format!("field count {actual} exceeds {limit}"),
        span,
    )
}

fn require_pure(expression: &HirExpr, position: &str) -> Result<(), Diagnostic> {
    if expression.effects.is_empty() {
        Ok(())
    } else {
        Err(diag(
            DiagnosticCode::EffectEscape,
            format!(
                "{position} must be pure; bind the effectful result first (found {:?})",
                expression.effects
            ),
            expression.span,
        ))
    }
}

fn require_pure_all<'a>(
    expressions: impl IntoIterator<Item = &'a HirExpr>,
    position: &str,
) -> Result<(), Diagnostic> {
    for expression in expressions {
        require_pure(expression, position)?;
    }
    Ok(())
}

fn empty_span() -> SourceSpan {
    SourceSpan::empty(crate::SourceLocation::start())
}

// Kept separate so diagnostics can later attach the exact duplicate-key span without changing
// constructor code.
fn key_span(_key: &str, span: SourceSpan) -> SourceSpan {
    span
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> StaticProfile {
        StaticProfile {
            tools: BTreeMap::from([
                (
                    "read".into(),
                    ToolSignature {
                        arguments: BTreeMap::from([("path".into(), Type::String)]),
                        required: BTreeSet::from(["path".into()]),
                        result: Type::Json,
                    },
                ),
                ("search".into(), ToolSignature::dynamic_json()),
            ]),
            host_operations: BTreeMap::from([
                (
                    "objective.report".into(),
                    ToolSignature {
                        arguments: BTreeMap::from([(
                            "objective".into(),
                            Type::Ref("Objective".into()),
                        )]),
                        required: BTreeSet::from(["objective".into()]),
                        result: Type::Nil,
                    },
                ),
                (
                    "context.propose".into(),
                    ToolSignature {
                        arguments: BTreeMap::from([(
                            "transaction".into(),
                            Type::ContextTransaction,
                        )]),
                        required: BTreeSet::from(["transaction".into()]),
                        result: Type::Json,
                    },
                ),
            ]),
            bindings: BTreeMap::from([(
                "runtime".into(),
                Type::StructuralRecord(BTreeMap::from([
                    ("objective".into(), Type::Ref("Objective".into())),
                    ("context".into(), Type::Ref("Context".into())),
                ])),
            )]),
        }
    }

    fn typed(body: &str) -> String {
        format!("(eval {body})")
    }

    #[test]
    fn analyzes_bindings_pure_expressions_and_exact_types() {
        let program = analyze(
            &typed("(seq (bind x (add 1 2.5)) (if (gt x 2) x 0))"),
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap();
        assert_eq!(program.output, Type::Float);
        assert!(program.effects.is_empty());
    }

    #[test]
    fn eval_and_infer_share_one_complete_typed_body() {
        let body = "(seq (bind total (add 20 22)) (if (gt total 40) (mul total 2) 0))";
        let runtime = analyze(
            &format!("(eval {body})"),
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap();
        let model = analyze(
            &format!("(infer {body})"),
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap();

        assert_eq!(runtime.owner, EvaluationOwner::Runtime);
        assert_eq!(model.owner, EvaluationOwner::Model);
        assert_eq!(runtime.output, Type::Int);
        assert_eq!(model.output, runtime.output);
        assert_eq!(model.effects, runtime.effects);
        let HirKind::InferBody {
            body: model_body,
            source,
            ..
        } = &model.body.kind
        else {
            panic!("model-owned root did not preserve its complete Yao body")
        };
        assert_eq!(model_body.ty, runtime.body.ty);
        assert_eq!(source, &format!("(infer {body})"));

        let nested = analyze(
            &format!("(eval (infer {body}))"),
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap();
        assert_eq!(nested.output, Type::Int);
        assert_eq!(nested.effects, EffectSet::new([Effect::Infer]));
    }

    #[test]
    fn model_owned_body_preserves_declared_tool_program_structure() {
        let source = r#"(infer
            (requires (tools read))
            (seq
              (bind listing (call read (path "README.md")))
              listing))"#;
        let program = analyze(source, &profile(), AnalysisLimits::default()).unwrap();
        assert_eq!(program.output, Type::Json);
        assert_eq!(
            program.effects,
            EffectSet::new([Effect::Tool("read".into())])
        );
        let HirKind::InferBody { source, .. } = &program.body.kind else {
            panic!("expected a complete model-owned body")
        };
        assert!(source.starts_with("(infer (requires (tools read))"));
        assert!(source.contains("(bind listing (call read (path \"README.md\")))"));
        assert!(source.ends_with("listing))"));
    }

    #[test]
    fn model_owned_root_preserves_named_type_declarations_in_provider_source() {
        let source = r#"(infer
            (types (record Answer (value Int)))
            (record Answer (value 42)))"#;
        let program = analyze(source, &profile(), AnalysisLimits::default()).unwrap();
        let HirKind::InferBody {
            source: provider_source,
            ..
        } = &program.body.kind
        else {
            panic!("expected complete model-owned BODY")
        };
        assert_eq!(
            provider_source,
            &canonical_source(&parse_one(source, ParseLimits::default()).unwrap())
        );
        assert!(provider_source.contains("(types (record Answer (value Int)))"));
    }

    #[test]
    fn nested_model_body_captures_only_explicit_parent_bindings() {
        let source =
            "(eval (seq (bind base 40) (bind hidden 99) (infer (captures base) (add base 2))))";
        let program = analyze(source, &profile(), AnalysisLimits::default()).unwrap();
        assert_eq!(program.output, Type::Int);
        assert_eq!(program.effects, EffectSet::new([Effect::Infer]));

        let error = analyze(
            "(eval (seq (bind base 40) (infer (add base 2))))",
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap_err();
        assert_eq!(error.code, DiagnosticCode::UnknownName);
        assert!(error.message.contains("base"));

        let error = analyze(
            "(eval (seq (bind base 40) (infer (captures missing) (add base 2))))",
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap_err();
        assert_eq!(error.code, DiagnosticCode::UnknownName);
        assert!(error.message.contains("capture 'missing'"));

        let error = analyze(
            "(eval (infer runtime.context))",
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap_err();
        assert_eq!(error.code, DiagnosticCode::UnknownName);
        assert!(error.message.contains("runtime"));

        let explicit_runtime = analyze(
            "(eval (infer (captures runtime) runtime.context))",
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap();
        assert_eq!(explicit_runtime.output, Type::Ref("Context".into()));
    }

    #[test]
    fn complete_model_body_may_declare_a_program_value_result_contract() {
        let source = r#"(eval
            (infer
              (returns (Program Int (effects)))
              (seq
                (bind candidate (add 20 22))
                candidate)))"#;
        let program = analyze(source, &profile(), AnalysisLimits::default()).unwrap();
        assert_eq!(
            program.output,
            Type::Program {
                output: Box::new(Type::Int),
                effects: EffectSet::default(),
            }
        );
        assert_eq!(program.effects, EffectSet::new([Effect::Infer]));
        let HirKind::InferBody { body, result, .. } = &program.body.kind else {
            panic!("expected full model-owned BODY")
        };
        assert_eq!(body.ty, Type::Int);
        assert_eq!(result, &program.output);

        let error = analyze(
            r#"(eval (infer (returns String) (add 20 22)))"#,
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap_err();
        assert_eq!(error.code, DiagnosticCode::TypeMismatch);
        assert!(error.message.contains("not assignable"));
    }

    #[test]
    fn bare_names_containing_exponent_letters_are_references_not_float_literals() {
        let program = analyze(
            &typed("(seq (bind e 2) (bind evidence (add e 1)) (mul evidence e))"),
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap();

        assert_eq!(program.output, Type::Int);

        let error = analyze(
            &typed("(seq (bind value 1) (add value 1e))"),
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap_err();
        assert_eq!(error.code, DiagnosticCode::TypeMismatch);
        assert!(error.message.contains("invalid Float literal '1e'"));
    }

    #[test]
    fn dollar_prefixed_reference_is_rejected_with_bare_name_migration() {
        let error = analyze(
            &typed("(seq (bind total (add 20 22)) (mul $total 2))"),
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap_err();

        assert_eq!(error.code, DiagnosticCode::UnknownName);
        assert!(error.message.contains("do not use '$'"));
        assert!(error.message.contains("replace '$total' with 'total'"));
    }

    #[test]
    fn heterogeneous_dict_reports_the_conflicting_field_and_recommends_record() {
        let error = analyze(
            "(eval\n  (dict\n    (sum 42)\n    (note \"done\")))",
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap_err();

        assert_eq!(error.code, DiagnosticCode::TypeMismatch);
        assert_eq!(error.primary.start.line, 4);
        assert_eq!(error.related.len(), 1);
        assert_eq!(error.related[0].start.line, 3);
        assert!(error.message.contains("dict field 'note'"));
        assert!(error.message.contains("homogeneous Map<T>"));
        assert!(error.message.contains("named record"));
    }

    #[test]
    fn named_record_is_the_typed_heterogeneous_object_constructor() {
        let program = analyze(
            "(eval (types (record Answer (value Int) (note String))) (record Answer (value 42) (note \"done\")))",
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap();

        assert_eq!(program.output, Type::Named("Answer".into()));
    }

    #[test]
    fn option_and_result_constructors_are_independently_typed() {
        let some = analyze(&typed("(some 7)"), &profile(), AnalysisLimits::default()).unwrap();
        assert_eq!(some.output, Type::Option(Box::new(Type::Int)));

        let none = analyze(
            &typed("(none String)"),
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap();
        assert_eq!(none.output, Type::Option(Box::new(Type::String)));

        let ok = analyze(
            &typed("(ok 7 String)"),
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap();
        assert_eq!(
            ok.output,
            Type::Result {
                ok: Box::new(Type::Int),
                error: Box::new(Type::String),
            }
        );

        let err = analyze(
            &typed("(err \"bad\" Int)"),
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap();
        assert_eq!(err.output, ok.output);
    }

    #[test]
    fn host_view_is_typed_from_the_ref_kind_and_requires_a_record_projection() {
        let program = analyze(
            &typed("(host.view runtime.objective (returns Json))"),
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap();
        assert_eq!(program.output, Type::Json);
        assert_eq!(
            program.effects,
            EffectSet::new([Effect::Host("view.Objective".into())])
        );

        let error = analyze(
            &typed("(host.view runtime.objective (returns String))"),
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap_err();
        assert_eq!(error.code, DiagnosticCode::InvalidType);

        let narrowed = analyze(
            r#"(eval
                 (requires (objects Context))
                 (host.view runtime.objective (returns Json)))"#,
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap_err();
        assert_eq!(narrowed.code, DiagnosticCode::EffectEscape);
    }

    #[test]
    fn semantic_candidates_are_pure_typed_and_cannot_be_decoded_from_json() {
        let evidence = analyze(
            &typed(
                r#"(evidence
                     (kind "test-result")
                     (value (dict (passed true)))
                     (refs))"#,
            ),
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap();
        assert_eq!(evidence.output, Type::EvidenceCandidate);
        assert!(evidence.effects.is_empty());

        let outcome = analyze(
            &typed(
                r#"(outcome
                     (status blocked)
                     (value (dict (reason "waiting")))
                     (evidence))"#,
            ),
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap();
        assert_eq!(outcome.output, Type::OutcomeCandidate);
        assert!(outcome.effects.is_empty());

        let forged = analyze(
            &typed("(decode EvidenceCandidate (dict (kind \"fake\")))"),
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap_err();
        assert_eq!(forged.code, DiagnosticCode::InvalidType);
    }

    #[test]
    fn context_transaction_is_sealed_canonical_and_host_typed() {
        let program = analyze(
            &typed(
                r#"(context.propose
                     (context-transaction
                       (context runtime.context)
                       (transaction
                         (context-tx
                           (base-version 7)
                           (reason "record verified fact")
                           (create verified-fact (fact true))))))"#,
            ),
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap();
        assert!(program
            .effects
            .contains(&Effect::Host("context.propose".into())));
        let HirKind::Host { arguments, .. } = &program.body.kind else {
            panic!("expected context.propose Host HIR")
        };
        assert_eq!(arguments[0].values[0].ty, Type::ContextTransaction);
        let HirKind::ContextTransaction {
            canonical_source, ..
        } = &arguments[0].values[0].kind
        else {
            panic!("expected sealed ContextTransaction HIR")
        };
        assert_eq!(
            canonical_source,
            "(context-tx (base-version 7) (reason \"record verified fact\") (create verified-fact (fact true)))"
        );

        let forged = analyze(
            &typed("(decode ContextTransaction (dict (kind \"context_transaction\")))"),
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap_err();
        assert_eq!(forged.code, DiagnosticCode::InvalidType);
    }

    #[test]
    fn option_and_result_constructors_reject_ambiguous_or_effectful_payloads() {
        for source in ["(ok 1)", "(err \"bad\")", "(none Missing)"] {
            assert!(analyze(&typed(source), &profile(), AnalysisLimits::default()).is_err());
        }
        let source = r#"
          (eval
            (requires (tools read))
            (some (call read (path "x"))))
        "#;
        assert_eq!(
            analyze(source, &profile(), AnalysisLimits::default())
                .unwrap_err()
                .code,
            DiagnosticCode::EffectEscape
        );
    }

    #[test]
    fn decode_cannot_forge_refs_or_program_values_even_through_named_types() {
        for body in [
            r#"(decode (Ref Objective) (dict (id "forged")))"#,
            r#"(decode (Program Int (effects)) (dict (hash "forged")))"#,
        ] {
            let error = analyze(&typed(body), &profile(), AnalysisLimits::default()).unwrap_err();
            assert_eq!(error.code, DiagnosticCode::InvalidType);
            assert!(error.message.contains("cannot construct"));
        }

        let nested = r#"
          (eval
            (types (record Forged (objective (Ref Objective))))
            (decode Forged (dict (objective nil))))
        "#;
        assert_eq!(
            analyze(nested, &profile(), AnalysisLimits::default())
                .unwrap_err()
                .code,
            DiagnosticCode::InvalidType
        );
    }

    #[test]
    fn rejects_truthiness_and_unquoted_strings_in_typed_programs() {
        let error = analyze(
            &typed("(if \"yes\" 1 0)"),
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap_err();
        assert_eq!(error.code, DiagnosticCode::TypeMismatch);

        let error = analyze(&typed("unquoted"), &profile(), AnalysisLimits::default()).unwrap_err();
        assert_eq!(error.code, DiagnosticCode::UnknownName);
    }

    #[test]
    fn rejects_in_band_source_version_declarations() {
        let error = analyze(
            r#"(eval (version "0.1") (add 20 22))"#,
            &profile(),
            AnalysisLimits::default(),
        )
        .unwrap_err();
        assert_eq!(error.code, DiagnosticCode::InvalidType);
        assert!(error.message.contains("no in-band version declaration"));
    }

    #[test]
    fn rejects_historical_lowercase_type_aliases() {
        for alias in ["text", "json"] {
            let source = format!("(infer (requires (tools)) (task \"decide\") (returns {alias}))");
            let error = analyze(&source, &profile(), AnalysisLimits::default()).unwrap_err();
            assert_eq!(error.code, DiagnosticCode::InvalidType);
            assert!(error.message.contains("unknown type"), "{error}");
        }
    }

    #[test]
    fn named_union_match_is_exhaustive_and_typed() {
        let source = r#"
          (eval
            (types
              (union Decision
                (accept (reason String) (confidence Float))
                (reject (reason String))))
            (seq
              (bind decision
                (variant Decision.accept
                  (reason "evidence")
                  (confidence 0.9)))
              (match decision
                ((case Decision.accept (reason why) (confidence score)) why)
                ((case Decision.reject (reason why)) why))))
        "#;
        let program = analyze(source, &profile(), AnalysisLimits::default()).unwrap();
        assert_eq!(program.output, Type::String);

        let non_exhaustive = source.replace("((case Decision.reject (reason why)) why)", "");
        let error = analyze(&non_exhaustive, &profile(), AnalysisLimits::default()).unwrap_err();
        assert!(error.message.contains("non-exhaustive"));
    }

    #[test]
    fn rejects_unknown_and_recursive_named_types() {
        let unknown = "(eval (types (record A (value Missing))) (seq 1))";
        assert_eq!(
            analyze(unknown, &profile(), AnalysisLimits::default())
                .unwrap_err()
                .code,
            DiagnosticCode::InvalidType
        );

        let recursive = r#"
          (eval
            (types (record A (next (Option B))) (record B (next A)))
            nil)
        "#;
        assert_eq!(
            analyze(recursive, &profile(), AnalysisLimits::default())
                .unwrap_err()
                .code,
            DiagnosticCode::RecursiveType
        );
    }

    #[test]
    fn statically_infers_tool_infer_and_host_effects() {
        let source = r#"
          (eval
            (requires
              (tools read search)
              (effects infer (tool read) (tool search) (host objective.report)))
            (seq
              (bind found
                (infer
                  (task "find evidence")
                  (tools search)
                  (returns Json)))
              (call read (path "README.md"))
              (objective.report (objective runtime.objective))))
        "#;
        let program = analyze(source, &profile(), AnalysisLimits::default()).unwrap();
        assert!(program.effects.contains(&Effect::Infer));
        assert!(program.effects.contains(&Effect::Tool("read".into())));
        assert!(program.effects.contains(&Effect::Tool("search".into())));
        assert!(program
            .effects
            .contains(&Effect::Host("objective.report".into())));
    }

    #[test]
    fn rejects_effect_escape_before_execution() {
        let source = r#"
          (eval
            (requires (tools read) (effects (tool read)))
            (infer (task "judge") (returns String)))
        "#;
        let error = analyze(source, &profile(), AnalysisLimits::default()).unwrap_err();
        assert_eq!(error.code, DiagnosticCode::EffectEscape);
    }

    #[test]
    fn parallel_branches_are_isolated_named_and_effect_typed() {
        let source = r#"
          (eval
            (requires (tools read))
            (par
              (branch local (seq (bind private 1) (add private 1)))
              (branch remote (call read (path "README.md")))))
        "#;
        let program = analyze(source, &profile(), AnalysisLimits::default()).unwrap();
        assert!(program.effects.contains(&Effect::Tool("read".into())));
        let Type::StructuralRecord(fields) = program.output else {
            panic!("par must produce a structural record")
        };
        assert_eq!(fields["local"], Type::Int);
        assert_eq!(fields["remote"], Type::Json);

        let duplicate = source.replace("branch remote", "branch local");
        assert_eq!(
            analyze(&duplicate, &profile(), AnalysisLimits::default())
                .unwrap_err()
                .code,
            DiagnosticCode::DuplicateName
        );
    }

    #[test]
    fn program_values_keep_output_and_effect_upper_bound() {
        let source = r#"
          (eval
            (requires (tools read) (effects infer (program (tool read))))
            (seq
              (bind plan
                (infer
                  (task "produce a program")
                  (returns (Program Json (effects (tool read))))))
              (run plan)))
        "#;
        let program = analyze(source, &profile(), AnalysisLimits::default()).unwrap();
        assert_eq!(program.output, Type::Json);
        assert!(program.effects.contains(&Effect::Infer));
        assert!(program
            .effects
            .contains(&Effect::Program(Box::new(EffectSet::new([Effect::Tool(
                "read".into()
            )])))));
    }

    #[test]
    fn static_limits_reject_oversized_parallelism_and_hir() {
        let source = typed("(par (branch a 1) (branch b 2) (branch c 3))");
        let error = analyze(
            &source,
            &profile(),
            AnalysisLimits {
                max_par_branches: 2,
                ..AnalysisLimits::default()
            },
        )
        .unwrap_err();
        assert_eq!(error.code, DiagnosticCode::ResourceLimit);

        let error = analyze(
            &typed("(seq 1 2 3 4)"),
            &profile(),
            AnalysisLimits {
                max_hir_nodes: 3,
                ..AnalysisLimits::default()
            },
        )
        .unwrap_err();
        assert_eq!(error.code, DiagnosticCode::ResourceLimit);
    }
}
