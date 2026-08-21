use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map as JsonMap, Value as JsonValue};

use crate::diagnostic::SourceSpan;
use crate::sema::{HirExpr, HirKind, Literal, PureOperator, TypeDefinition};
use crate::types::Type;

const YAO_TAG: &str = "$yao";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvalFailure {
    pub message: String,
    pub span: SourceSpan,
}

/// Read-only view over a Runtime-constructed Evidence candidate. The private
/// JSON transport remains an implementation detail, while host profiles can
/// still validate referenced Evidence before crossing an authority boundary.
#[derive(Debug, Clone, PartialEq)]
pub struct EvidenceCandidateView<'a> {
    pub evidence_kind: &'a str,
    pub value: &'a JsonValue,
    pub refs: &'a [JsonValue],
}

/// Read-only view over a Runtime-constructed Outcome candidate.
#[derive(Debug, Clone, PartialEq)]
pub struct OutcomeCandidateView<'a> {
    pub status: &'a str,
    pub value: &'a JsonValue,
    pub evidence: &'a [JsonValue],
}

impl std::fmt::Display for EvalFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}:{}: {}",
            self.span.start.line, self.span.start.column, self.message
        )
    }
}

impl std::error::Error for EvalFailure {}

/// Evaluates a statically pure HIR expression. The semantic analyzer ensures that no effectful
/// child can hide beneath a pure operator; this function checks the invariant again because HIR is
/// serializable and may cross a trust boundary.
pub fn evaluate_pure(
    expression: &HirExpr,
    environment: &mut HashMap<String, JsonValue>,
    definitions: &BTreeMap<String, TypeDefinition>,
) -> Result<JsonValue, EvalFailure> {
    if !expression.effects.is_empty() {
        return fail(
            expression,
            format!(
                "pure evaluator received effectful expression {:?}",
                expression.effects
            ),
        );
    }
    match &expression.kind {
        HirKind::Literal { value } => literal_value(value, expression),
        HirKind::Reference { root, path } => {
            let mut value = environment.get(root).cloned().ok_or_else(|| EvalFailure {
                message: format!("binding '${root}' is unavailable at runtime"),
                span: expression.span,
            })?;
            for field in path {
                value = read_field(&value, field).ok_or_else(|| EvalFailure {
                    message: format!("value at '${root}' has no field '{field}'"),
                    span: expression.span,
                })?;
            }
            Ok(value)
        }
        HirKind::List { elements } => elements
            .iter()
            .map(|value| evaluate_pure(value, environment, definitions))
            .collect::<Result<Vec<_>, _>>()
            .map(JsonValue::Array),
        HirKind::Dict { entries } => {
            let mut output = JsonMap::new();
            for (name, value) in entries {
                output.insert(
                    name.clone(),
                    evaluate_pure(value, environment, definitions)?,
                );
            }
            Ok(JsonValue::Object(output))
        }
        HirKind::Record { type_name, fields } => {
            tagged_fields("record", type_name, None, fields, environment, definitions)
        }
        HirKind::Variant {
            type_name,
            variant,
            fields,
        } => tagged_fields(
            "variant",
            type_name,
            Some(variant),
            fields,
            environment,
            definitions,
        ),
        HirKind::OptionSome { value } => Ok(json!({
            YAO_TAG: {
                "kind": "option",
                "variant": "some",
                "value": evaluate_pure(value, environment, definitions)?,
            }
        })),
        HirKind::OptionNone { .. } => Ok(json!({
            YAO_TAG: {
                "kind": "option",
                "variant": "none",
            }
        })),
        HirKind::ResultOk { value, .. } => Ok(json!({
            YAO_TAG: {
                "kind": "result",
                "variant": "ok",
                "value": evaluate_pure(value, environment, definitions)?,
            }
        })),
        HirKind::ResultErr { value, .. } => Ok(json!({
            YAO_TAG: {
                "kind": "result",
                "variant": "err",
                "value": evaluate_pure(value, environment, definitions)?,
            }
        })),
        HirKind::EvidenceCandidate { kind, value, refs } => Ok(json!({
            YAO_TAG: {
                "kind": "evidence_candidate",
                "evidence_kind": evaluate_pure(kind, environment, definitions)?,
                "value": evaluate_pure(value, environment, definitions)?,
                "refs": refs
                    .iter()
                    .map(|reference| evaluate_pure(reference, environment, definitions))
                    .collect::<Result<Vec<_>, _>>()?,
            }
        })),
        HirKind::OutcomeCandidate {
            status,
            value,
            evidence,
        } => Ok(json!({
            YAO_TAG: {
                "kind": "outcome_candidate",
                "status": status,
                "value": evaluate_pure(value, environment, definitions)?,
                "evidence": evidence
                    .iter()
                    .map(|reference| evaluate_pure(reference, environment, definitions))
                    .collect::<Result<Vec<_>, _>>()?,
            }
        })),
        HirKind::Get { value, field } => {
            let value = evaluate_pure(value, environment, definitions)?;
            read_field(&value, field).ok_or_else(|| EvalFailure {
                message: format!("value has no field '{field}'"),
                span: expression.span,
            })
        }
        HirKind::Decode { target, value } => {
            let value = evaluate_pure(value, environment, definitions)?;
            decode_value(target, value, definitions, expression.span)
        }
        HirKind::Is { target, value } => {
            let value = evaluate_pure(value, environment, definitions)?;
            Ok(JsonValue::Bool(
                decode_value(target, value, definitions, expression.span).is_ok(),
            ))
        }
        HirKind::Pure { operator, operands } => {
            evaluate_operator(*operator, operands, environment, definitions, expression)
        }
        HirKind::Seq { steps } => {
            let mut result = JsonValue::Null;
            for step in steps {
                result = evaluate_pure(step, environment, definitions)?;
            }
            Ok(result)
        }
        HirKind::Bind { name, value } => {
            let value = evaluate_pure(value, environment, definitions)?;
            if environment.insert(name.clone(), value).is_some() {
                return fail(expression, format!("binding '{name}' was overwritten"));
            }
            Ok(JsonValue::Null)
        }
        HirKind::If {
            condition,
            when_true,
            when_false,
        } => match evaluate_pure(condition, environment, definitions)? {
            JsonValue::Bool(true) => {
                evaluate_branch(when_true, environment, definitions).map(|(_, value)| value)
            }
            JsonValue::Bool(false) => {
                evaluate_branch(when_false, environment, definitions).map(|(_, value)| value)
            }
            _ => fail(expression, "if condition was not Bool after type checking"),
        },
        HirKind::Match { value, cases } => {
            let value = evaluate_pure(value, environment, definitions)?;
            let (variant, fields) = variant_parts(&value).ok_or_else(|| EvalFailure {
                message: "match value is not a Yao union variant".to_string(),
                span: expression.span,
            })?;
            let case = cases
                .iter()
                .find(|case| case.variant == variant)
                .ok_or_else(|| EvalFailure {
                    message: format!("no match case for variant '{variant}'"),
                    span: expression.span,
                })?;
            let mut branch_environment = environment.clone();
            for binding in &case.bindings {
                let value = fields
                    .get(&binding.field)
                    .cloned()
                    .ok_or_else(|| EvalFailure {
                        message: format!(
                            "variant '{}' is missing field '{}'",
                            case.variant, binding.field
                        ),
                        span: case.span,
                    })?;
                branch_environment.insert(binding.binding.clone(), value);
            }
            evaluate_pure(&case.body, &mut branch_environment, definitions)
        }
        HirKind::Fallback { primary, backup } => {
            let mut primary_environment = environment.clone();
            match evaluate_pure(primary, &mut primary_environment, definitions) {
                Ok(value) => Ok(value),
                Err(_) => evaluate_branch(backup, environment, definitions).map(|(_, value)| value),
            }
        }
        HirKind::Map {
            collection,
            element,
            body,
        } => {
            let value = evaluate_pure(collection, environment, definitions)?;
            let JsonValue::Array(items) = value else {
                return fail(
                    expression,
                    "map collection was not a List after type checking",
                );
            };
            let mut output = Vec::with_capacity(items.len());
            for item in items {
                let mut body_environment = environment.clone();
                body_environment.insert(element.clone(), item);
                output.push(evaluate_pure(body, &mut body_environment, definitions)?);
            }
            Ok(JsonValue::Array(output))
        }
        HirKind::Par { branches } => {
            let mut fields = Vec::with_capacity(branches.len());
            for branch in branches {
                let (_, value) = evaluate_branch(&branch.body, environment, definitions)?;
                fields.push(json!({"name": branch.name, "value": value}));
            }
            Ok(json!({
                YAO_TAG: {
                    "kind": "structural_record",
                    "fields": fields,
                }
            }))
        }
        HirKind::Call { .. }
        | HirKind::Infer { .. }
        | HirKind::Run { .. }
        | HirKind::Host { .. } => fail(
            expression,
            "effectful node reached the pure evaluator after semantic analysis",
        ),
    }
}

/// Validates and normalizes one transport value against a Yao type.
pub fn decode_value(
    target: &Type,
    value: JsonValue,
    definitions: &BTreeMap<String, TypeDefinition>,
    span: SourceSpan,
) -> Result<JsonValue, EvalFailure> {
    match target {
        Type::Json => Ok(value),
        Type::Nil if value.is_null() => Ok(value),
        Type::Bool if value.is_boolean() => Ok(value),
        Type::Int if value.as_i64().is_some() => Ok(value),
        Type::Float if value.as_f64().is_some() => Ok(value),
        Type::String if value.is_string() => Ok(value),
        Type::Bytes if value.is_string() => Ok(value),
        Type::List(element) => {
            let JsonValue::Array(values) = value else {
                return type_failure(target, &value, span);
            };
            values
                .into_iter()
                .map(|value| decode_value(element, value, definitions, span))
                .collect::<Result<Vec<_>, _>>()
                .map(JsonValue::Array)
        }
        Type::Map(element) => {
            let JsonValue::Object(values) = value else {
                return type_failure(target, &value, span);
            };
            values
                .into_iter()
                .map(|(name, value)| {
                    decode_value(element, value, definitions, span).map(|value| (name, value))
                })
                .collect::<Result<JsonMap<_, _>, _>>()
                .map(JsonValue::Object)
        }
        Type::StructuralRecord(fields) => {
            if let Some(encoded) = structural_fields(&value) {
                let mut output = Vec::new();
                for (name, ty) in fields {
                    let Some(field_value) = encoded.get(name).cloned() else {
                        return Err(EvalFailure {
                            message: format!("record is missing field '{name}'"),
                            span,
                        });
                    };
                    output.push(json!({
                        "name": name,
                        "value": decode_value(ty, field_value, definitions, span)?,
                    }));
                }
                Ok(json!({YAO_TAG: {"kind": "structural_record", "fields": output}}))
            } else if let JsonValue::Object(mut object) = value {
                let mut output = Vec::new();
                for (name, ty) in fields {
                    let Some(field_value) = object.remove(name) else {
                        return Err(EvalFailure {
                            message: format!("record is missing field '{name}'"),
                            span,
                        });
                    };
                    output.push(json!({
                        "name": name,
                        "value": decode_value(ty, field_value, definitions, span)?,
                    }));
                }
                if !object.is_empty() {
                    return Err(EvalFailure {
                        message: format!(
                            "record contains unknown fields: {}",
                            object.keys().cloned().collect::<Vec<_>>().join(", ")
                        ),
                        span,
                    });
                }
                Ok(json!({YAO_TAG: {"kind": "structural_record", "fields": output}}))
            } else {
                type_failure(target, &value, span)
            }
        }
        Type::Option(inner) => decode_tagged_unary("option", inner, value, definitions, span),
        Type::Result { ok, error } => decode_result(ok, error, value, definitions, span),
        Type::EvidenceCandidate if evidence_candidate_view(&value).is_some() => Ok(value),
        Type::OutcomeCandidate if outcome_candidate_view(&value).is_some() => Ok(value),
        Type::Named(name) => decode_named(name, value, definitions, span),
        Type::Ref(kind) => {
            let Some(tag) = yao_object(&value) else {
                return type_failure(target, &value, span);
            };
            if tag.get("kind").and_then(JsonValue::as_str) == Some("ref")
                && tag.get("ref_kind").and_then(JsonValue::as_str) == Some(kind)
                && tag.get("id").and_then(JsonValue::as_str).is_some()
            {
                Ok(value)
            } else {
                type_failure(target, &value, span)
            }
        }
        Type::Program { .. } => {
            let Some(tag) = yao_object(&value) else {
                return type_failure(target, &value, span);
            };
            if tag.get("kind").and_then(JsonValue::as_str) == Some("program")
                && tag.get("hash").and_then(JsonValue::as_str).is_some()
            {
                Ok(value)
            } else {
                type_failure(target, &value, span)
            }
        }
        _ => type_failure(target, &value, span),
    }
}

fn literal_value(value: &Literal, expression: &HirExpr) -> Result<JsonValue, EvalFailure> {
    Ok(match value {
        Literal::Nil => JsonValue::Null,
        Literal::Bool(value) => JsonValue::Bool(*value),
        Literal::Int(value) => JsonValue::Number((*value).into()),
        Literal::Float(source) => {
            let value = source.parse::<f64>().map_err(|_| EvalFailure {
                message: format!("invalid Float literal '{source}'"),
                span: expression.span,
            })?;
            if !value.is_finite() {
                return fail(expression, "Float literal is not finite");
            }
            JsonValue::Number(
                serde_json::Number::from_f64(value).ok_or_else(|| EvalFailure {
                    message: "Float literal cannot be represented".to_string(),
                    span: expression.span,
                })?,
            )
        }
        Literal::String(value) => JsonValue::String(value.clone()),
    })
}

fn tagged_fields(
    kind: &str,
    type_name: &str,
    variant: Option<&str>,
    fields: &[(String, HirExpr)],
    environment: &mut HashMap<String, JsonValue>,
    definitions: &BTreeMap<String, TypeDefinition>,
) -> Result<JsonValue, EvalFailure> {
    let mut encoded = JsonMap::new();
    for (name, value) in fields {
        encoded.insert(
            name.clone(),
            evaluate_pure(value, environment, definitions)?,
        );
    }
    let mut tag = JsonMap::from_iter([
        ("kind".to_string(), json!(kind)),
        ("type".to_string(), json!(type_name)),
        ("fields".to_string(), JsonValue::Object(encoded)),
    ]);
    if let Some(variant) = variant {
        tag.insert("variant".to_string(), json!(variant));
    }
    Ok(JsonValue::Object(JsonMap::from_iter([(
        YAO_TAG.to_string(),
        JsonValue::Object(tag),
    )])))
}

fn evaluate_branch(
    expression: &HirExpr,
    environment: &HashMap<String, JsonValue>,
    definitions: &BTreeMap<String, TypeDefinition>,
) -> Result<(HashMap<String, JsonValue>, JsonValue), EvalFailure> {
    let mut branch_environment = environment.clone();
    let value = evaluate_pure(expression, &mut branch_environment, definitions)?;
    Ok((branch_environment, value))
}

fn evaluate_operator(
    operator: PureOperator,
    operands: &[HirExpr],
    environment: &mut HashMap<String, JsonValue>,
    definitions: &BTreeMap<String, TypeDefinition>,
    expression: &HirExpr,
) -> Result<JsonValue, EvalFailure> {
    match operator {
        PureOperator::And => {
            for operand in operands {
                if !as_bool(
                    evaluate_pure(operand, environment, definitions)?,
                    expression,
                )? {
                    return Ok(JsonValue::Bool(false));
                }
            }
            Ok(JsonValue::Bool(true))
        }
        PureOperator::Or => {
            for operand in operands {
                if as_bool(
                    evaluate_pure(operand, environment, definitions)?,
                    expression,
                )? {
                    return Ok(JsonValue::Bool(true));
                }
            }
            Ok(JsonValue::Bool(false))
        }
        PureOperator::Not => Ok(JsonValue::Bool(!as_bool(
            evaluate_pure(&operands[0], environment, definitions)?,
            expression,
        )?)),
        _ => {
            let values = operands
                .iter()
                .map(|operand| evaluate_pure(operand, environment, definitions))
                .collect::<Result<Vec<_>, _>>()?;
            match operator {
                PureOperator::Equal => Ok(JsonValue::Bool(values[0] == values[1])),
                PureOperator::NotEqual => Ok(JsonValue::Bool(values[0] != values[1])),
                PureOperator::Less
                | PureOperator::LessEqual
                | PureOperator::Greater
                | PureOperator::GreaterEqual => compare(operator, &values, expression),
                PureOperator::Add
                | PureOperator::Subtract
                | PureOperator::Multiply
                | PureOperator::Divide => numeric(operator, &values, expression),
                PureOperator::And | PureOperator::Or | PureOperator::Not => unreachable!(),
            }
        }
    }
}

fn compare(
    operator: PureOperator,
    values: &[JsonValue],
    expression: &HirExpr,
) -> Result<JsonValue, EvalFailure> {
    let ordering = if let (Some(left), Some(right)) = (values[0].as_f64(), values[1].as_f64()) {
        left.partial_cmp(&right)
    } else if let (Some(left), Some(right)) = (values[0].as_str(), values[1].as_str()) {
        Some(left.cmp(right))
    } else {
        None
    }
    .ok_or_else(|| EvalFailure {
        message: "ordered comparison received incomparable values".to_string(),
        span: expression.span,
    })?;
    Ok(JsonValue::Bool(match operator {
        PureOperator::Less => ordering.is_lt(),
        PureOperator::LessEqual => ordering.is_le(),
        PureOperator::Greater => ordering.is_gt(),
        PureOperator::GreaterEqual => ordering.is_ge(),
        _ => unreachable!(),
    }))
}

fn numeric(
    operator: PureOperator,
    values: &[JsonValue],
    expression: &HirExpr,
) -> Result<JsonValue, EvalFailure> {
    let all_int = values.iter().all(|value| value.as_i64().is_some());
    if all_int && operator != PureOperator::Divide {
        let integers = values
            .iter()
            .map(|value| value.as_i64().expect("checked"))
            .collect::<Vec<_>>();
        let result = match operator {
            PureOperator::Add => integers.into_iter().try_fold(0_i64, i64::checked_add),
            PureOperator::Subtract => integers[0].checked_sub(integers[1]),
            PureOperator::Multiply => integers.into_iter().try_fold(1_i64, i64::checked_mul),
            _ => unreachable!(),
        }
        .ok_or_else(|| EvalFailure {
            message: "integer arithmetic overflow".to_string(),
            span: expression.span,
        })?;
        return Ok(JsonValue::Number(result.into()));
    }
    let numbers = values
        .iter()
        .map(|value| {
            value.as_f64().ok_or_else(|| EvalFailure {
                message: "numeric operator received a non-number".to_string(),
                span: expression.span,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    if operator == PureOperator::Divide && numbers[1] == 0.0 {
        return fail(expression, "division by zero");
    }
    let result = match operator {
        PureOperator::Add => numbers.iter().sum(),
        PureOperator::Subtract => numbers[0] - numbers[1],
        PureOperator::Multiply => numbers.iter().product(),
        PureOperator::Divide => numbers[0] / numbers[1],
        _ => unreachable!(),
    };
    if !result.is_finite() {
        return fail(expression, "floating-point result is not finite");
    }
    Ok(JsonValue::Number(
        serde_json::Number::from_f64(result).ok_or_else(|| EvalFailure {
            message: "floating-point result cannot be represented".to_string(),
            span: expression.span,
        })?,
    ))
}

fn as_bool(value: JsonValue, expression: &HirExpr) -> Result<bool, EvalFailure> {
    value.as_bool().ok_or_else(|| EvalFailure {
        message: "boolean operator received a non-Bool value".to_string(),
        span: expression.span,
    })
}

fn read_field(value: &JsonValue, field: &str) -> Option<JsonValue> {
    if let Some(tag) = yao_object(value) {
        match tag.get("kind").and_then(JsonValue::as_str) {
            Some("record" | "variant") => tag.get("fields")?.get(field).cloned(),
            Some("structural_record") => tag
                .get("fields")?
                .as_array()?
                .iter()
                .find(|entry| entry.get("name").and_then(JsonValue::as_str) == Some(field))?
                .get("value")
                .cloned(),
            _ => None,
        }
    } else {
        value.get(field).cloned()
    }
}

fn yao_object(value: &JsonValue) -> Option<&JsonMap<String, JsonValue>> {
    value.get(YAO_TAG)?.as_object()
}

fn variant_parts(value: &JsonValue) -> Option<(&str, &JsonMap<String, JsonValue>)> {
    let tag = yao_object(value)?;
    if tag.get("kind")?.as_str()? != "variant" {
        return None;
    }
    Some((
        tag.get("variant")?.as_str()?,
        tag.get("fields")?.as_object()?,
    ))
}

/// Returns the discriminant and payload fields of a validated nominal union value.
///
/// Runtime hosts need this small, representation-safe view when an effectful `match` suspends in
/// one of its case bodies. Keeping the tag decoding here prevents each host from depending on the
/// private JSON encoding used by the pure evaluator.
pub fn variant_view(value: &JsonValue) -> Option<(String, BTreeMap<String, JsonValue>)> {
    let (variant, fields) = variant_parts(value)?;
    Some((
        variant.to_string(),
        fields
            .iter()
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect(),
    ))
}

/// Constructs the canonical runtime representation of a compiler-produced structural record.
/// Field order is semantic for `par` results and is therefore preserved from the iterator.
pub fn structural_record_value(fields: impl IntoIterator<Item = (String, JsonValue)>) -> JsonValue {
    let fields = fields
        .into_iter()
        .map(|(name, value)| json!({"name": name, "value": value}))
        .collect::<Vec<_>>();
    json!({YAO_TAG: {"kind": "structural_record", "fields": fields}})
}

/// Constructs the canonical runtime representation of an opaque host reference.
///
/// This constructor is intentionally host-only: Yao source has no corresponding
/// expression, so a program cannot turn an arbitrary string into a `Ref<K>`.
pub fn reference_value(kind: impl Into<String>, id: impl Into<String>) -> JsonValue {
    json!({
        YAO_TAG: {
            "kind": "ref",
            "ref_kind": kind.into(),
            "id": id.into(),
        }
    })
}

/// Reads an already validated opaque host reference without exposing the
/// private transport shape to Runtime profiles.
pub fn reference_view(value: &JsonValue) -> Option<(&str, &str)> {
    let tag = yao_object(value)?;
    if tag.get("kind")?.as_str()? != "ref" {
        return None;
    }
    Some((tag.get("ref_kind")?.as_str()?, tag.get("id")?.as_str()?))
}

/// Decodes the canonical Evidence candidate representation. Exact field sets
/// and `Ref<Evidence>` members are checked because serialized HIR and machine
/// state cross a persistence trust boundary.
pub fn evidence_candidate_view(value: &JsonValue) -> Option<EvidenceCandidateView<'_>> {
    if value.as_object()?.len() != 1 {
        return None;
    }
    let tag = yao_object(value)?;
    if tag.len() != 4 || tag.get("kind")?.as_str()? != "evidence_candidate" {
        return None;
    }
    let evidence_kind = tag.get("evidence_kind")?.as_str()?;
    if evidence_kind.is_empty() {
        return None;
    }
    let refs = tag.get("refs")?.as_array()?;
    if refs
        .iter()
        .any(|reference| reference_view(reference).map(|(kind, _)| kind) != Some("Evidence"))
    {
        return None;
    }
    Some(EvidenceCandidateView {
        evidence_kind,
        value: tag.get("value")?,
        refs,
    })
}

/// Decodes the canonical Outcome candidate representation and rejects
/// invented status values or non-Evidence dependencies.
pub fn outcome_candidate_view(value: &JsonValue) -> Option<OutcomeCandidateView<'_>> {
    if value.as_object()?.len() != 1 {
        return None;
    }
    let tag = yao_object(value)?;
    if tag.len() != 4 || tag.get("kind")?.as_str()? != "outcome_candidate" {
        return None;
    }
    let status = tag.get("status")?.as_str()?;
    if !matches!(status, "succeeded" | "failed" | "blocked") {
        return None;
    }
    let evidence = tag.get("evidence")?.as_array()?;
    if evidence
        .iter()
        .any(|reference| reference_view(reference).map(|(kind, _)| kind) != Some("Evidence"))
    {
        return None;
    }
    Some(OutcomeCandidateView {
        status,
        value: tag.get("value")?,
        evidence,
    })
}

/// Constructs the canonical `Option<Ref<K>>` representation used by host
/// evaluation environments.
pub fn optional_reference_value(kind: &str, id: Option<&str>) -> JsonValue {
    match id {
        Some(id) => json!({
            YAO_TAG: {
                "kind": "option",
                "variant": "some",
                "value": reference_value(kind, id),
            }
        }),
        None => json!({
            YAO_TAG: {
                "kind": "option",
                "variant": "none",
            }
        }),
    }
}

fn structural_fields(value: &JsonValue) -> Option<BTreeMap<String, JsonValue>> {
    let tag = yao_object(value)?;
    if tag.get("kind")?.as_str()? != "structural_record" {
        return None;
    }
    let mut output = BTreeMap::new();
    for field in tag.get("fields")?.as_array()? {
        output.insert(
            field.get("name")?.as_str()?.to_string(),
            field.get("value")?.clone(),
        );
    }
    Some(output)
}

/// Reads one field from a canonical structural record without making its
/// transport representation part of a host profile's implementation.
pub fn structural_record_field<'a>(value: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    let tag = yao_object(value)?;
    if tag.get("kind")?.as_str()? != "structural_record" {
        return None;
    }
    tag.get("fields")?
        .as_array()?
        .iter()
        .find(|entry| entry.get("name").and_then(JsonValue::as_str) == Some(name))?
        .get("value")
}

fn decode_named(
    name: &str,
    value: JsonValue,
    definitions: &BTreeMap<String, TypeDefinition>,
    span: SourceSpan,
) -> Result<JsonValue, EvalFailure> {
    let Some(definition) = definitions.get(name) else {
        return Err(EvalFailure {
            message: format!("unknown named type '{name}' during decode"),
            span,
        });
    };
    let Some(tag) = yao_object(&value) else {
        return type_failure(&Type::Named(name.into()), &value, span);
    };
    if tag.get("type").and_then(JsonValue::as_str) != Some(name) {
        return type_failure(&Type::Named(name.into()), &value, span);
    }
    match definition {
        TypeDefinition::Record { fields, .. } => {
            if tag.get("kind").and_then(JsonValue::as_str) != Some("record") {
                return type_failure(&Type::Named(name.into()), &value, span);
            }
            validate_named_fields(fields, tag, definitions, span)?;
        }
        TypeDefinition::Union { variants, .. } => {
            if tag.get("kind").and_then(JsonValue::as_str) != Some("variant") {
                return type_failure(&Type::Named(name.into()), &value, span);
            }
            let variant = tag
                .get("variant")
                .and_then(JsonValue::as_str)
                .ok_or_else(|| EvalFailure {
                    message: format!("union '{name}' value has no variant"),
                    span,
                })?;
            let Some(definition) = variants.iter().find(|item| item.name == variant) else {
                return Err(EvalFailure {
                    message: format!("union '{name}' has no variant '{variant}'"),
                    span,
                });
            };
            validate_named_fields(&definition.fields, tag, definitions, span)?;
        }
    }
    Ok(value)
}

fn validate_named_fields(
    definitions_to_check: &[crate::sema::FieldDefinition],
    tag: &JsonMap<String, JsonValue>,
    definitions: &BTreeMap<String, TypeDefinition>,
    span: SourceSpan,
) -> Result<(), EvalFailure> {
    let fields = tag
        .get("fields")
        .and_then(JsonValue::as_object)
        .ok_or_else(|| EvalFailure {
            message: "named value has no fields object".to_string(),
            span,
        })?;
    if fields.len() != definitions_to_check.len() {
        return Err(EvalFailure {
            message: "named value field count does not match its type".to_string(),
            span,
        });
    }
    for definition in definitions_to_check {
        let Some(value) = fields.get(&definition.name).cloned() else {
            return Err(EvalFailure {
                message: format!("named value is missing field '{}'", definition.name),
                span,
            });
        };
        decode_value(&definition.ty, value, definitions, span)?;
    }
    Ok(())
}

fn decode_tagged_unary(
    kind: &str,
    inner: &Type,
    value: JsonValue,
    definitions: &BTreeMap<String, TypeDefinition>,
    span: SourceSpan,
) -> Result<JsonValue, EvalFailure> {
    let Some(tag) = yao_object(&value) else {
        return type_failure(&Type::Option(Box::new(inner.clone())), &value, span);
    };
    if tag.get("kind").and_then(JsonValue::as_str) != Some(kind) {
        return type_failure(&Type::Option(Box::new(inner.clone())), &value, span);
    }
    match tag.get("variant").and_then(JsonValue::as_str) {
        Some("none") => Ok(value),
        Some("some") => {
            let inner_value = tag.get("value").cloned().ok_or_else(|| EvalFailure {
                message: "some value is missing its payload".to_string(),
                span,
            })?;
            decode_value(inner, inner_value, definitions, span)?;
            Ok(value)
        }
        _ => type_failure(&Type::Option(Box::new(inner.clone())), &value, span),
    }
}

fn decode_result(
    ok: &Type,
    error: &Type,
    value: JsonValue,
    definitions: &BTreeMap<String, TypeDefinition>,
    span: SourceSpan,
) -> Result<JsonValue, EvalFailure> {
    let Some(tag) = yao_object(&value) else {
        return type_failure(
            &Type::Result {
                ok: Box::new(ok.clone()),
                error: Box::new(error.clone()),
            },
            &value,
            span,
        );
    };
    if tag.get("kind").and_then(JsonValue::as_str) != Some("result") {
        return type_failure(
            &Type::Result {
                ok: Box::new(ok.clone()),
                error: Box::new(error.clone()),
            },
            &value,
            span,
        );
    }
    let payload = tag.get("value").cloned().ok_or_else(|| EvalFailure {
        message: "Result value is missing its payload".to_string(),
        span,
    })?;
    match tag.get("variant").and_then(JsonValue::as_str) {
        Some("ok") => {
            decode_value(ok, payload, definitions, span)?;
            Ok(value)
        }
        Some("err") => {
            decode_value(error, payload, definitions, span)?;
            Ok(value)
        }
        _ => type_failure(
            &Type::Result {
                ok: Box::new(ok.clone()),
                error: Box::new(error.clone()),
            },
            &value,
            span,
        ),
    }
}

fn type_failure(
    target: &Type,
    value: &JsonValue,
    span: SourceSpan,
) -> Result<JsonValue, EvalFailure> {
    Err(EvalFailure {
        message: format!("value {value} does not satisfy {target:?}"),
        span,
    })
}

fn fail<T>(expression: &HirExpr, message: impl Into<String>) -> Result<T, EvalFailure> {
    Err(EvalFailure {
        message: message.into(),
        span: expression.span,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeSet, HashMap};

    use crate::sema::{analyze, AnalysisLimits, StaticProfile, ToolSignature};

    use super::*;

    fn evaluate(source: &str) -> Result<JsonValue, EvalFailure> {
        let program = analyze(
            &format!("(eval {source})"),
            &StaticProfile::default(),
            AnalysisLimits::default(),
        )
        .unwrap();
        evaluate_pure(&program.body, &mut HashMap::new(), &program.types)
    }

    #[test]
    fn evaluates_bindings_control_and_checked_arithmetic() {
        assert_eq!(
            evaluate("(seq (bind x (add 2 3)) (if (eq $x 5) (mul $x 2) 0))").unwrap(),
            json!(10)
        );
        assert!(evaluate("(div 1 0)").unwrap_err().message.contains("zero"));
        assert!(evaluate("(add 9223372036854775807 1)")
            .unwrap_err()
            .message
            .contains("overflow"));
    }

    #[test]
    fn evaluates_and_decodes_option_and_result_constructors() {
        let some = evaluate("(some 7)").unwrap();
        assert_eq!(some[YAO_TAG]["variant"], "some");
        assert_eq!(some[YAO_TAG]["value"], 7);

        let none = evaluate("(none String)").unwrap();
        assert_eq!(none[YAO_TAG]["variant"], "none");
        let span = SourceSpan::empty(crate::SourceLocation::start());
        assert!(decode_value(
            &Type::Option(Box::new(Type::String)),
            none,
            &BTreeMap::new(),
            span,
        )
        .is_ok());

        let ok = evaluate("(ok 7 String)").unwrap();
        assert!(decode_value(
            &Type::Result {
                ok: Box::new(Type::Int),
                error: Box::new(Type::String),
            },
            ok,
            &BTreeMap::new(),
            span,
        )
        .is_ok());
        let wrong = evaluate("(ok \"seven\" String)").unwrap();
        assert!(decode_value(
            &Type::Result {
                ok: Box::new(Type::Int),
                error: Box::new(Type::String),
            },
            wrong,
            &BTreeMap::new(),
            span,
        )
        .is_err());
    }

    #[test]
    fn evaluates_semantic_candidates_with_runtime_only_transport_tags() {
        let evidence = evaluate(
            r#"(evidence
                 (kind "test-result")
                 (value (dict (passed true)))
                 (refs))"#,
        )
        .unwrap();
        assert_eq!(evidence[YAO_TAG]["kind"], "evidence_candidate");
        assert_eq!(evidence[YAO_TAG]["value"]["passed"], true);
        let span = SourceSpan::empty(crate::SourceLocation::start());
        assert!(decode_value(&Type::EvidenceCandidate, evidence, &BTreeMap::new(), span,).is_ok());
        assert!(decode_value(
            &Type::EvidenceCandidate,
            json!({"kind": "evidence_candidate"}),
            &BTreeMap::new(),
            span,
        )
        .is_err());
        for forged in [
            json!({"$yao": {
                "kind": "evidence_candidate",
                "evidence_kind": "",
                "value": null,
                "refs": []
            }}),
            json!({"$yao": {
                "kind": "evidence_candidate",
                "evidence_kind": "test-result",
                "value": null,
                "refs": [reference_value("Outcome", "wrong-kind")]
            }}),
            json!({"$yao": {
                "kind": "evidence_candidate",
                "evidence_kind": "test-result",
                "value": null,
                "refs": [],
                "unexpected": true
            }}),
        ] {
            assert!(
                decode_value(&Type::EvidenceCandidate, forged, &BTreeMap::new(), span,).is_err()
            );
        }

        let outcome = evaluate(
            r#"(outcome
                 (status succeeded)
                 (value "done")
                 (evidence))"#,
        )
        .unwrap();
        assert_eq!(outcome[YAO_TAG]["kind"], "outcome_candidate");
        assert_eq!(outcome[YAO_TAG]["status"], "succeeded");
        assert!(decode_value(
            &Type::OutcomeCandidate,
            json!({"$yao": {
                "kind": "outcome_candidate",
                "status": "invented",
                "value": null,
                "evidence": []
            }}),
            &BTreeMap::new(),
            span,
        )
        .is_err());
    }

    #[test]
    fn evaluates_nominal_union_match_without_leaking_case_bindings() {
        let source = r#"
          (eval
            (types (union Decision (accept (reason String)) (reject (reason String))))
            (seq
              (bind decision (variant Decision.accept (reason "verified")))
              (match $decision
                ((case Decision.accept (reason why)) $why)
                ((case Decision.reject (reason why)) $why))))
        "#;
        let program =
            analyze(source, &StaticProfile::default(), AnalysisLimits::default()).unwrap();
        let mut environment = HashMap::new();
        assert_eq!(
            evaluate_pure(&program.body, &mut environment, &program.types).unwrap(),
            json!("verified")
        );
        assert!(!environment.contains_key("why"));
    }

    #[test]
    fn pure_par_preserves_source_order_in_tagged_record() {
        let value = evaluate("(par (branch z 1) (branch a 2))").unwrap();
        let fields = value[YAO_TAG]["fields"].as_array().unwrap();
        assert_eq!(fields[0]["name"], "z");
        assert_eq!(fields[1]["name"], "a");
    }

    #[test]
    fn pure_evaluator_rejects_serialized_effectful_hir() {
        let profile = StaticProfile {
            tools: BTreeMap::from([(
                "read".into(),
                ToolSignature {
                    arguments: BTreeMap::from([("path".into(), Type::String)]),
                    required: BTreeSet::from(["path".into()]),
                    result: Type::Json,
                },
            )]),
            ..StaticProfile::default()
        };
        let program = analyze(
            "(eval (requires (tools read)) (call read (path \"x\")))",
            &profile,
            AnalysisLimits::default(),
        )
        .unwrap();
        assert!(
            evaluate_pure(&program.body, &mut HashMap::new(), &program.types)
                .unwrap_err()
                .message
                .contains("effectful")
        );
    }

    #[test]
    fn typed_decode_rejects_missing_and_unknown_record_fields() {
        let ty = Type::StructuralRecord(BTreeMap::from([("name".into(), Type::String)]));
        let span = SourceSpan::empty(crate::SourceLocation::start());
        assert!(decode_value(&ty, json!({}), &BTreeMap::new(), span).is_err());
        assert!(decode_value(
            &ty,
            json!({"name": "ok", "extra": 1}),
            &BTreeMap::new(),
            span
        )
        .is_err());
        assert!(decode_value(&ty, json!({"name": "ok"}), &BTreeMap::new(), span).is_ok());
    }
}
