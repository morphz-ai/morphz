//! Explicit, strict adapters between ordinary JSON and Yao data values.
//! Internal nominal tags are never inferred from arbitrary Json fields.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Map, Value};

use crate::diagnostic::SourceSpan;
use crate::eval::{decode_value, EvalFailure};
use crate::sema::TypeDefinition;
use crate::types::Type;

type Definitions = BTreeMap<String, TypeDefinition>;

/// Reject duplicate object keys instead of silently accepting the last value.
/// Used for model result text; ordinary Value adapters cannot recover discarded keys.
pub fn parse_strict_json(text: &str) -> Result<Value, serde_json::Error> {
    use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
    struct Strict(Value);
    struct StrictVisitor;
    impl<'de> Deserialize<'de> for Strict {
        fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            d.deserialize_any(StrictVisitor)
        }
    }
    impl<'de> Visitor<'de> for StrictVisitor {
        type Value = Strict;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("one strict JSON value")
        }
        fn visit_unit<E: de::Error>(self) -> Result<Strict, E> {
            Ok(Strict(Value::Null))
        }
        fn visit_bool<E: de::Error>(self, v: bool) -> Result<Strict, E> {
            Ok(Strict(v.into()))
        }
        fn visit_i64<E: de::Error>(self, v: i64) -> Result<Strict, E> {
            Ok(Strict(v.into()))
        }
        fn visit_u64<E: de::Error>(self, v: u64) -> Result<Strict, E> {
            Ok(Strict(v.into()))
        }
        fn visit_f64<E: de::Error>(self, v: f64) -> Result<Strict, E> {
            serde_json::Number::from_f64(v)
                .map(|n| Strict(Value::Number(n)))
                .ok_or_else(|| E::custom("nonfinite JSON number"))
        }
        fn visit_str<E: de::Error>(self, v: &str) -> Result<Strict, E> {
            Ok(Strict(v.into()))
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Strict, A::Error> {
            let mut values = Vec::new();
            while let Some(Strict(value)) = seq.next_element()? {
                values.push(value);
            }
            Ok(Strict(Value::Array(values)))
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Strict, A::Error> {
            let mut values = Map::new();
            while let Some(key) = map.next_key::<String>()? {
                if values.contains_key(&key) {
                    return Err(de::Error::custom(format!("duplicate JSON field {key:?}")));
                }
                let Strict(value) = map.next_value()?;
                values.insert(key, value);
            }
            Ok(Strict(Value::Object(values)))
        }
    }
    let mut decoder = serde_json::Deserializer::from_str(text);
    let Strict(value) = Strict::deserialize(&mut decoder)?;
    decoder.end()?;
    Ok(value)
}

/// Reject authority-bearing types, including those nested inside declared data types.
pub fn validate_json_type(ty: &Type, definitions: &Definitions) -> Result<(), String> {
    fn visit(
        ty: &Type,
        defs: &Definitions,
        stack: &mut BTreeSet<String>,
        done: &mut BTreeSet<String>,
    ) -> Result<(), String> {
        match ty {
            Type::Nil | Type::Bool | Type::Int | Type::Float | Type::String | Type::Bytes | Type::Json => Ok(()),
            Type::List(inner) | Type::Map(inner) | Type::Option(inner) => visit(inner, defs, stack, done),
            Type::Result { ok, error } => { visit(ok, defs, stack, done)?; visit(error, defs, stack, done) }
            Type::StructuralRecord(fields) => fields.values().try_for_each(|ty| visit(ty, defs, stack, done)),
            Type::Named(name) => {
                if done.contains(name) { return Ok(()); }
                if !stack.insert(name.clone()) { return Err(format!("recursive JSON type '{name}'")); }
                let definition = defs.get(name).ok_or_else(|| format!("unknown JSON type '{name}'"))?;
                let fields: Vec<_> = match definition {
                    TypeDefinition::Record { fields, .. } => fields.iter().collect(),
                    TypeDefinition::Union { variants, .. } => variants.iter().flat_map(|v| &v.fields).collect(),
                };
                for field in fields { visit(&field.ty, defs, stack, done)?; }
                stack.remove(name);
                done.insert(name.clone());
                Ok(())
            }
            _ => Err(format!("{ty:?} cannot cross an ordinary JSON boundary; authority-bearing values require Runtime admission")),
        }
    }
    visit(ty, definitions, &mut BTreeSet::new(), &mut BTreeSet::new())
}

pub fn from_json(
    ty: &Type,
    value: Value,
    definitions: &Definitions,
    span: SourceSpan,
) -> Result<Value, EvalFailure> {
    convert(ty, value, definitions, span, false)
}

pub fn to_json(
    ty: &Type,
    value: Value,
    definitions: &Definitions,
    span: SourceSpan,
) -> Result<Value, EvalFailure> {
    convert(ty, value, definitions, span, true)
}

fn convert(
    ty: &Type,
    value: Value,
    defs: &Definitions,
    span: SourceSpan,
    outward: bool,
) -> Result<Value, EvalFailure> {
    validate_json_type(ty, defs).map_err(|message| EvalFailure { message, span })?;
    transform(ty, value, defs, span, outward, "$").map_err(|message| EvalFailure { message, span })
}

fn field_path(path: &str, name: &str) -> String {
    format!(
        "{path}[{}]",
        serde_json::to_string(name).expect("string serialization")
    )
}

fn object(value: Value, path: &str) -> Result<Map<String, Value>, String> {
    match value {
        Value::Object(value) => Ok(value),
        other => Err(format!("{path}: expected object, found {}", shape(&other))),
    }
}

fn shape(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn take(fields: &mut Map<String, Value>, name: &str, path: &str) -> Result<Value, String> {
    fields
        .remove(name)
        .ok_or_else(|| format!("{}: missing required field", field_path(path, name)))
}

fn empty(fields: &Map<String, Value>, path: &str) -> Result<(), String> {
    match fields.keys().next() {
        Some(key) => Err(format!("{}: unknown field", field_path(path, key))),
        None => Ok(()),
    }
}

fn transform_fields(
    fields: impl IntoIterator<Item = (String, Type)>,
    value: Value,
    defs: &Definitions,
    span: SourceSpan,
    outward: bool,
    path: &str,
) -> Result<Value, String> {
    let mut input = object(value, path)?;
    let mut output = Map::new();
    for (name, ty) in fields {
        let value = take(&mut input, &name, path)?;
        output.insert(
            name.clone(),
            transform(&ty, value, defs, span, outward, &field_path(path, &name))?,
        );
    }
    empty(&input, path)?;
    Ok(Value::Object(output))
}

fn transform(
    ty: &Type,
    value: Value,
    defs: &Definitions,
    span: SourceSpan,
    outward: bool,
    path: &str,
) -> Result<Value, String> {
    match ty {
        Type::Json => Ok(value), // Deliberately opaque, even if it contains "$yao".
        Type::List(inner) => {
            let Value::Array(values) = value else {
                return Err(format!("{path}: expected array, found {}", shape(&value)));
            };
            values
                .into_iter()
                .enumerate()
                .map(|(i, value)| {
                    transform(inner, value, defs, span, outward, &format!("{path}[{i}]"))
                })
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array)
        }
        Type::Map(inner) => object(value, path)?
            .into_iter()
            .map(|(name, value)| {
                transform(inner, value, defs, span, outward, &field_path(path, &name))
                    .map(|value| (name, value))
            })
            .collect::<Result<Map<_, _>, _>>()
            .map(Value::Object),
        Type::Named(name) => {
            let definition = &defs[name];
            let (variant, fields_value) = if outward {
                // Validate nominal identity before exposing its fields. JSON cannot cast one
                // record to another merely because the field names happen to match.
                decode_value(ty, value.clone(), defs, span)
                    .map_err(|_| format!("{path}: expected canonical {ty:?}"))?;
                let tag = &value["$yao"];
                (
                    tag["variant"].as_str().map(str::to_owned),
                    tag["fields"].clone(),
                )
            } else if matches!(definition, TypeDefinition::Union { .. }) {
                let mut envelope = object(value, path)?;
                let variant = take(&mut envelope, "case", path)?
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| {
                        format!("{}: expected variant name", field_path(path, "case"))
                    })?;
                let fields = take(&mut envelope, "fields", path)?;
                empty(&envelope, path)?;
                (Some(variant), fields)
            } else {
                (None, value)
            };
            let fields = match definition {
                TypeDefinition::Record { fields, .. } => fields,
                TypeDefinition::Union { variants, .. } => {
                    &variants
                        .iter()
                        .find(|item| Some(item.name.as_str()) == variant.as_deref())
                        .ok_or_else(|| {
                            format!("{}: unknown variant for {name}", field_path(path, "case"))
                        })?
                        .fields
                }
            };
            let fields_path = if variant.is_some() {
                field_path(path, "fields")
            } else {
                path.to_owned()
            };
            let fields = transform_fields(
                fields.iter().map(|f| (f.name.clone(), f.ty.clone())),
                fields_value,
                defs,
                span,
                outward,
                &fields_path,
            )?;
            if outward {
                Ok(match variant {
                    Some(variant) => json!({"case": variant, "fields": fields}),
                    None => fields,
                })
            } else {
                Ok(match variant {
                    Some(variant) => {
                        json!({"$yao": {"kind": "variant", "type": name, "variant": variant, "fields": fields}})
                    }
                    None => json!({"$yao": {"kind": "record", "type": name, "fields": fields}}),
                })
            }
        }
        Type::StructuralRecord(fields) => {
            let value = if outward {
                decode_value(ty, value.clone(), defs, span)
                    .map_err(|_| format!("{path}: expected canonical structural record"))?;
                Value::Object(
                    fields
                        .keys()
                        .map(|name| {
                            (
                                name.clone(),
                                crate::eval::structural_record_field(&value, name)
                                    .cloned()
                                    .unwrap_or(Value::Null),
                            )
                        })
                        .collect(),
                )
            } else {
                value
            };
            let fields_value = transform_fields(fields.clone(), value, defs, span, outward, path)?;
            if outward {
                Ok(fields_value)
            } else {
                Ok(
                    json!({"$yao": {"kind": "structural_record", "fields": fields_value.as_object().expect("checked object").iter().map(|(name, value)| json!({"name": name, "value": value})).collect::<Vec<_>>()}}),
                )
            }
        }
        Type::Option(_) | Type::Result { .. } => {
            let kind = if matches!(ty, Type::Option(_)) {
                "option"
            } else {
                "result"
            };
            let mut envelope = if outward {
                decode_value(ty, value.clone(), defs, span)
                    .map_err(|_| format!("{path}: expected canonical {ty:?}"))?;
                let mut tag = object(value["$yao"].clone(), path)?;
                tag.remove("kind");
                let case = take(&mut tag, "variant", path)?;
                tag.insert("case".into(), case);
                tag
            } else {
                object(value, path)?
            };
            let case = take(&mut envelope, "case", path)?
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| format!("{}: expected string", field_path(path, "case")))?;
            let inner = match (ty, case.as_str()) {
                (Type::Option(_), "none") => None,
                (Type::Option(inner), "some") => Some(inner.as_ref()),
                (Type::Result { ok, .. }, "ok") => Some(ok.as_ref()),
                (Type::Result { error, .. }, "err") => Some(error.as_ref()),
                _ => {
                    return Err(format!(
                        "{}: invalid case for {ty:?}",
                        field_path(path, "case")
                    ))
                }
            };
            let mut result = Map::new();
            result.insert(
                if outward { "case" } else { "variant" }.into(),
                Value::String(case),
            );
            if let Some(inner) = inner {
                let payload = take(&mut envelope, "value", path)?;
                result.insert(
                    "value".into(),
                    transform(
                        inner,
                        payload,
                        defs,
                        span,
                        outward,
                        &field_path(path, "value"),
                    )?,
                );
            }
            empty(&envelope, path)?;
            if outward {
                Ok(Value::Object(result))
            } else {
                result.insert("kind".into(), Value::String(kind.into()));
                Ok(json!({"$yao": result}))
            }
        }
        _ => decode_value(ty, value.clone(), defs, span)
            .map_err(|_| format!("{path}: expected {ty:?}, found {}", shape(&value))),
    }
}

/// A compact schema for the model-facing result contract; nominal definitions are
/// shared instead of exponentially expanding repeated nested record references.
pub fn json_schema(ty: &Type, definitions: &Definitions) -> Result<Value, String> {
    validate_json_type(ty, definitions)?;
    fn record(
        fields: impl IntoIterator<Item = (String, Type)>,
        pending: &mut BTreeSet<String>,
    ) -> Value {
        let properties: Map<_, _> = fields
            .into_iter()
            .map(|(name, ty)| (name, schema(&ty, pending)))
            .collect();
        let required: Vec<_> = properties.keys().cloned().collect();
        json!({"type":"object", "properties":properties, "required":required, "additionalProperties":false})
    }
    fn tagged(case: &str, payload: Option<(&str, Value)>) -> Value {
        let mut fields = Map::from_iter([("case".into(), json!({"const": case}))]);
        if let Some((key, value)) = payload {
            fields.insert(key.into(), value);
        }
        let required: Vec<_> = fields.keys().cloned().collect();
        json!({"type":"object", "properties":fields, "required":required, "additionalProperties":false})
    }
    fn schema(ty: &Type, pending: &mut BTreeSet<String>) -> Value {
        match ty {
            Type::Json => json!({}),
            Type::Nil => json!({"type":"null"}),
            Type::Bool => json!({"type":"boolean"}),
            Type::Int => json!({"type":"integer", "minimum":i64::MIN, "maximum":i64::MAX}),
            Type::Float => json!({"type":"number"}),
            Type::String | Type::Bytes => json!({"type":"string"}),
            Type::List(inner) => json!({"type":"array", "items":schema(inner, pending)}),
            Type::Map(inner) => {
                json!({"type":"object", "additionalProperties":schema(inner, pending)})
            }
            Type::Named(name) => {
                pending.insert(name.clone());
                json!({"$ref":format!("#/$defs/{}", name.replace('~', "~0").replace('/', "~1"))})
            }
            Type::StructuralRecord(fields) => record(fields.clone(), pending),
            Type::Option(inner) => {
                json!({"oneOf":[tagged("none", None), tagged("some", Some(("value", schema(inner, pending))))]})
            }
            Type::Result { ok, error } => {
                json!({"oneOf":[tagged("ok", Some(("value", schema(ok, pending)))), tagged("err", Some(("value", schema(error, pending))))]})
            }
            _ => unreachable!("JSON types validated"),
        }
    }
    let mut pending = BTreeSet::new();
    let mut output = schema(ty, &mut pending);
    let mut emitted = Map::new();
    while let Some(name) = pending.pop_first() {
        if emitted.contains_key(&name) {
            continue;
        }
        let definition = match &definitions[&name] {
            TypeDefinition::Record { fields, .. } => record(
                fields.iter().map(|f| (f.name.clone(), f.ty.clone())),
                &mut pending,
            ),
            TypeDefinition::Union { variants, .. } => {
                json!({"oneOf": variants.iter().map(|v| tagged(&v.name, Some(("fields", record(v.fields.iter().map(|f| (f.name.clone(), f.ty.clone())), &mut pending))))).collect::<Vec<_>>()})
            }
        };
        emitted.insert(name, definition);
    }
    if !emitted.is_empty() {
        output["$defs"] = Value::Object(emitted);
    }
    Ok(output)
}
