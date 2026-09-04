use serde_json::{Map, Value};
use std::collections::{BTreeSet, HashSet};

/// Google exposes two related but non-identical function declaration dialects.
/// The public Gemini API accepts `parametersJsonSchema`; the private
/// Antigravity endpoint consumes the older `parameters` field and supports a
/// smaller schema subset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GeminiToolSchemaDialect {
    PublicApi,
    Antigravity,
}

/// Project only function-declaration schemas. Tool arguments in conversation
/// history are ordinary JSON and may legitimately contain keys such as
/// `const`, `format`, or `default`; walking the whole request would corrupt
/// those already-observed arguments.
pub(crate) fn project_request_tool_schemas(
    mut request: Value,
    dialect: GeminiToolSchemaDialect,
) -> Value {
    let Some(tool_groups) = request.get_mut("tools").and_then(Value::as_array_mut) else {
        return request;
    };
    for tool_group in tool_groups {
        let Some(declarations) = tool_group
            .get_mut("functionDeclarations")
            .and_then(Value::as_array_mut)
        else {
            continue;
        };
        for declaration in declarations {
            let Some(object) = declaration.as_object_mut() else {
                continue;
            };
            let schema = object
                .remove("parametersJsonSchema")
                .or_else(|| object.remove("parameters"))
                .unwrap_or_else(empty_object_schema);
            let projected = project_tool_schema(&schema, dialect);
            match dialect {
                GeminiToolSchemaDialect::PublicApi => {
                    object.insert("parametersJsonSchema".to_string(), projected);
                    object.remove("parameters");
                }
                GeminiToolSchemaDialect::Antigravity => {
                    object.insert("parameters".to_string(), projected);
                    object.remove("parametersJsonSchema");
                }
            }
        }
    }
    request
}

fn empty_object_schema() -> Value {
    serde_json::json!({"type": "object", "properties": {}})
}

fn project_tool_schema(schema: &Value, dialect: GeminiToolSchemaDialect) -> Value {
    let root = schema.clone();
    let mut resolving_refs = HashSet::new();
    let projected = project_node(schema, &root, dialect, &mut resolving_refs, 0);
    ensure_schema_shape(projected)
}

fn project_node(
    schema: &Value,
    root: &Value,
    dialect: GeminiToolSchemaDialect,
    resolving_refs: &mut HashSet<String>,
    depth: usize,
) -> Value {
    if depth > 64 {
        return serde_json::json!({
            "type": "object",
            "description": "Recursive schema omitted after the supported nesting limit"
        });
    }
    let Some(source) = schema.as_object() else {
        return match schema {
            Value::Bool(true) => empty_object_schema(),
            Value::Bool(false) => serde_json::json!({
                "type": "object",
                "description": "No value is accepted by the canonical Runtime schema"
            }),
            _ => empty_object_schema(),
        };
    };

    if let Some(reference) = source.get("$ref").and_then(Value::as_str) {
        if let Some(pointer) = reference.strip_prefix('#') {
            if resolving_refs.insert(reference.to_string()) {
                if let Some(target) = root.pointer(pointer) {
                    let mut resolved =
                        project_node(target, root, dialect, resolving_refs, depth + 1);
                    resolving_refs.remove(reference);
                    let siblings = Value::Object(
                        source
                            .iter()
                            .filter(|(key, _)| key.as_str() != "$ref")
                            .map(|(key, value)| (key.clone(), value.clone()))
                            .collect(),
                    );
                    let siblings =
                        project_node(&siblings, root, dialect, resolving_refs, depth + 1);
                    merge_schema(&mut resolved, siblings, RequiredMerge::Union);
                    return resolved;
                }
                resolving_refs.remove(reference);
            }
        }
        let name = reference.rsplit('/').next().unwrap_or(reference);
        return serde_json::json!({
            "type": "object",
            "description": format!("See canonical Runtime schema reference: {name}")
        });
    }

    let mut output = Map::new();
    let mut description = source
        .get("description")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);

    let (schema_type, nullable) = normalized_type(source.get("type"));
    if let Some(schema_type) = schema_type {
        output.insert("type".to_string(), Value::String(schema_type));
    }
    if nullable {
        append_hint(&mut description, "Nullable");
        if dialect == GeminiToolSchemaDialect::Antigravity {
            output.insert("nullable".to_string(), Value::Bool(true));
        }
    }

    if let Some(properties) = source.get("properties").and_then(Value::as_object) {
        let mut projected_properties = Map::new();
        let mut boolean_required = Vec::new();
        for (name, property_schema) in properties {
            let mut property = property_schema.clone();
            if property
                .as_object()
                .and_then(|object| object.get("required"))
                .and_then(Value::as_bool)
                == Some(true)
            {
                if let Some(object) = property.as_object_mut() {
                    object.remove("required");
                }
                boolean_required.push(name.clone());
            }
            projected_properties.insert(
                name.clone(),
                project_node(&property, root, dialect, resolving_refs, depth + 1),
            );
        }
        output.insert("type".to_string(), Value::String("object".to_string()));
        output.insert(
            "properties".to_string(),
            Value::Object(projected_properties),
        );
        let mut required = required_names(source.get("required"));
        required.extend(boolean_required);
        set_filtered_required(&mut output, required);
    }

    if output.get("type").and_then(Value::as_str) == Some("array") {
        let items = source
            .get("items")
            .map(|items| project_node(items, root, dialect, resolving_refs, depth + 1))
            .unwrap_or_else(|| serde_json::json!({"type": "string"}));
        output.insert("items".to_string(), items);
    } else if let Some(items) = source.get("items") {
        output.insert(
            "items".to_string(),
            project_node(items, root, dialect, resolving_refs, depth + 1),
        );
    }

    if let Some(value) = source.get("const") {
        apply_enum(&mut output, vec![value.clone()], dialect, &mut description);
    } else if let Some(values) = source.get("enum").and_then(Value::as_array) {
        apply_enum(&mut output, values.clone(), dialect, &mut description);
    }

    for (keyword, label) in [
        ("minimum", "minimum"),
        ("maximum", "maximum"),
        ("exclusiveMinimum", "exclusive minimum"),
        ("exclusiveMaximum", "exclusive maximum"),
        ("minLength", "minimum length"),
        ("maxLength", "maximum length"),
        ("pattern", "pattern"),
        ("minItems", "minimum items"),
        ("maxItems", "maximum items"),
        ("uniqueItems", "unique items"),
        ("minProperties", "minimum properties"),
        ("maxProperties", "maximum properties"),
        ("multipleOf", "multiple of"),
    ] {
        if let Some(value) = source.get(keyword) {
            append_hint(&mut description, &format!("{label}: {}", compact(value)));
        }
    }
    if source.get("additionalProperties") == Some(&Value::Bool(false)) {
        append_hint(&mut description, "Additional properties are not accepted");
    }

    if let Some(all_of) = source.get("allOf").and_then(Value::as_array) {
        let mut current = Value::Object(output);
        for branch in all_of {
            let projected = project_node(branch, root, dialect, resolving_refs, depth + 1);
            merge_schema(&mut current, projected, RequiredMerge::Union);
        }
        output = current.as_object().cloned().unwrap_or_default();
    }

    if let Some(union) = source
        .get("oneOf")
        .or_else(|| source.get("anyOf"))
        .and_then(Value::as_array)
    {
        let projected = merge_union(union, root, dialect, resolving_refs, depth + 1);
        let mut current = Value::Object(output);
        merge_schema(&mut current, projected, RequiredMerge::Union);
        output = current.as_object().cloned().unwrap_or_default();
    }

    // Conditional branches are constraints in the canonical Runtime schema.
    // Preserve every field the model may need, while the Runtime remains the
    // authoritative validator of the selected combination.
    for keyword in ["then", "else"] {
        if let Some(branch) = source.get(keyword) {
            let projected = project_node(branch, root, dialect, resolving_refs, depth + 1);
            let mut current = Value::Object(output);
            merge_schema(&mut current, projected, RequiredMerge::Intersection);
            output = current.as_object().cloned().unwrap_or_default();
        }
    }
    if source.contains_key("if") {
        append_hint(
            &mut description,
            "Conditional combinations are validated by the Runtime",
        );
    }

    if let Some(description) = description.filter(|value| !value.trim().is_empty()) {
        output.insert("description".to_string(), Value::String(description));
    }
    Value::Object(output)
}

#[derive(Clone, Copy)]
enum RequiredMerge {
    Union,
    Intersection,
}

fn merge_union(
    branches: &[Value],
    root: &Value,
    dialect: GeminiToolSchemaDialect,
    resolving_refs: &mut HashSet<String>,
    depth: usize,
) -> Value {
    let projected = branches
        .iter()
        .map(|branch| project_node(branch, root, dialect, resolving_refs, depth + 1))
        .collect::<Vec<_>>();
    let object_like = projected.iter().all(|branch| {
        branch.get("type").and_then(Value::as_str) == Some("object")
            || branch.get("properties").is_some_and(Value::is_object)
    });
    if object_like {
        let mut merged = empty_object_schema();
        let required_sets = projected
            .iter()
            .map(|branch| required_names(branch.get("required")))
            .collect::<Vec<_>>();
        for branch in projected {
            merge_schema(&mut merged, branch, RequiredMerge::Intersection);
        }
        let common_required = required_sets
            .into_iter()
            .reduce(|left, right| left.intersection(&right).cloned().collect())
            .unwrap_or_default();
        if let Some(object) = merged.as_object_mut() {
            object.remove("required");
            set_filtered_required(object, common_required);
        }
        return merged;
    }

    let mut selected = projected
        .iter()
        .find(|branch| branch.get("type").and_then(Value::as_str) != Some("null"))
        .cloned()
        .unwrap_or_else(empty_object_schema);
    let accepted_types = projected
        .iter()
        .filter_map(|branch| branch.get("type").and_then(Value::as_str))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if accepted_types.len() > 1 {
        append_schema_description(
            &mut selected,
            &format!("Accepts: {}", accepted_types.join(" | ")),
        );
    }
    selected
}

fn merge_schema(target: &mut Value, incoming: Value, required_merge: RequiredMerge) {
    let Some(target_object) = target.as_object_mut() else {
        *target = incoming;
        return;
    };
    let Some(mut incoming_object) = incoming.as_object().cloned() else {
        return;
    };

    if let Some(incoming_properties) = incoming_object
        .remove("properties")
        .and_then(|value| value.as_object().cloned())
    {
        let properties = target_object
            .entry("properties")
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(properties) = properties.as_object_mut() {
            for (name, incoming_property) in incoming_properties {
                if let Some(existing) = properties.get_mut(&name) {
                    merge_property(existing, incoming_property);
                } else {
                    properties.insert(name, incoming_property);
                }
            }
        }
        target_object.insert("type".to_string(), Value::String("object".to_string()));
    }

    let current_required = required_names(target_object.get("required"));
    let incoming_required = required_names(incoming_object.get("required"));
    incoming_object.remove("required");
    let merged_required = match required_merge {
        RequiredMerge::Union => current_required
            .union(&incoming_required)
            .cloned()
            .collect(),
        RequiredMerge::Intersection => current_required
            .intersection(&incoming_required)
            .cloned()
            .collect(),
    };

    for (key, value) in incoming_object {
        match key.as_str() {
            "description" => {
                append_map_description(target_object, value.as_str().unwrap_or_default())
            }
            "enum" => merge_enum_values(target_object, value),
            _ => {
                target_object.entry(key).or_insert(value);
            }
        }
    }
    target_object.remove("required");
    set_filtered_required(target_object, merged_required);
}

fn merge_property(existing: &mut Value, incoming: Value) {
    if existing == &incoming {
        return;
    }
    let existing_type = existing
        .get("type")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let incoming_type = incoming
        .get("type")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    if existing_type == incoming_type {
        merge_schema(existing, incoming, RequiredMerge::Intersection);
        return;
    }
    let mut accepted = [existing_type.as_deref(), incoming_type.as_deref()]
        .into_iter()
        .flatten()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    accepted.sort_unstable();
    if !accepted.is_empty() {
        append_schema_description(existing, &format!("Accepts: {}", accepted.join(" | ")));
    }
}

fn merge_enum_values(object: &mut Map<String, Value>, incoming: Value) {
    let Some(incoming) = incoming.as_array() else {
        return;
    };
    let enum_value = object
        .entry("enum")
        .or_insert_with(|| Value::Array(Vec::new()));
    let Some(values) = enum_value.as_array_mut() else {
        return;
    };
    for value in incoming {
        if !values.contains(value) {
            values.push(value.clone());
        }
    }
}

fn apply_enum(
    output: &mut Map<String, Value>,
    values: Vec<Value>,
    dialect: GeminiToolSchemaDialect,
    description: &mut Option<String>,
) {
    if values.is_empty() {
        return;
    }
    let rendered = values.iter().map(compact).collect::<Vec<_>>().join(", ");
    if dialect == GeminiToolSchemaDialect::Antigravity {
        append_hint(description, &format!("Allowed: {rendered}"));
        return;
    }
    let all_strings = values.iter().all(Value::is_string);
    if all_strings {
        output.insert("type".to_string(), Value::String("string".to_string()));
    } else if output.get("type").is_none() {
        if let Some(schema_type) = values.first().and_then(json_type_name) {
            output.insert("type".to_string(), Value::String(schema_type.to_string()));
        }
    }
    output.insert("enum".to_string(), Value::Array(values));
}

fn normalized_type(value: Option<&Value>) -> (Option<String>, bool) {
    match value {
        Some(Value::String(value)) if value == "null" => (None, true),
        Some(Value::String(value)) => (Some(value.clone()), false),
        Some(Value::Array(values)) => {
            let nullable = values.iter().any(|value| value.as_str() == Some("null"));
            let schema_type = values
                .iter()
                .filter_map(Value::as_str)
                .find(|value| *value != "null")
                .map(ToOwned::to_owned);
            (schema_type, nullable)
        }
        _ => (None, false),
    }
}

fn json_type_name(value: &Value) -> Option<&'static str> {
    match value {
        Value::String(_) => Some("string"),
        Value::Bool(_) => Some("boolean"),
        Value::Number(number) if number.is_i64() || number.is_u64() => Some("integer"),
        Value::Number(_) => Some("number"),
        Value::Array(_) => Some("array"),
        Value::Object(_) => Some("object"),
        Value::Null => None,
    }
}

fn required_names(value: Option<&Value>) -> BTreeSet<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect()
}

fn set_filtered_required(object: &mut Map<String, Value>, required: BTreeSet<String>) {
    let Some(properties) = object.get("properties").and_then(Value::as_object) else {
        object.remove("required");
        return;
    };
    let required = required
        .into_iter()
        .filter(|name| properties.contains_key(name))
        .map(Value::String)
        .collect::<Vec<_>>();
    if required.is_empty() {
        object.remove("required");
    } else {
        object.insert("required".to_string(), Value::Array(required));
    }
}

fn ensure_schema_shape(mut schema: Value) -> Value {
    let Some(object) = schema.as_object_mut() else {
        return empty_object_schema();
    };
    if object.get("type").is_none() {
        object.insert("type".to_string(), Value::String("object".to_string()));
    }
    if object.get("type").and_then(Value::as_str) == Some("object") {
        object
            .entry("properties")
            .or_insert_with(|| Value::Object(Map::new()));
        let required = required_names(object.get("required"));
        object.remove("required");
        set_filtered_required(object, required);
    }
    schema
}

fn append_schema_description(schema: &mut Value, hint: &str) {
    let Some(object) = schema.as_object_mut() else {
        return;
    };
    append_map_description(object, hint);
}

fn append_map_description(object: &mut Map<String, Value>, hint: &str) {
    let mut description = object
        .get("description")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    append_hint(&mut description, hint);
    if let Some(description) = description {
        object.insert("description".to_string(), Value::String(description));
    }
}

fn append_hint(description: &mut Option<String>, hint: &str) {
    let hint = hint.trim();
    if hint.is_empty() {
        return;
    }
    match description {
        Some(existing) if existing.contains(hint) => {}
        Some(existing) if existing.trim().is_empty() => *existing = hint.to_string(),
        Some(existing) => {
            existing.push_str("; ");
            existing.push_str(hint);
        }
        None => *description = Some(hint.to_string()),
    }
}

fn compact(value: &Value) -> String {
    value
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn contains_schema_keyword(value: &Value, keyword: &str, in_properties: bool) -> bool {
        match value {
            Value::Array(values) => values
                .iter()
                .any(|value| contains_schema_keyword(value, keyword, false)),
            Value::Object(object) => object.iter().any(|(key, value)| {
                (!in_properties && key == keyword)
                    || contains_schema_keyword(value, keyword, key == "properties")
            }),
            _ => false,
        }
    }

    fn schedule_schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "operations": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "oneOf": [
                            {
                                "type": "object",
                                "properties": {
                                    "op": {"const": "inspect"},
                                    "schedule_id": {"type": "string"}
                                },
                                "required": ["op", "schedule_id"],
                                "additionalProperties": false
                            },
                            {
                                "type": "object",
                                "properties": {
                                    "op": {"const": "pause"},
                                    "schedule_id": {"type": "string"},
                                    "expected_revision": {"type": "integer", "minimum": 1}
                                },
                                "required": ["op", "schedule_id", "expected_revision"],
                                "additionalProperties": false
                            }
                        ]
                    }
                }
            },
            "required": ["operations", "stale"],
            "additionalProperties": false
        })
    }

    #[test]
    fn public_gemini_projects_discriminated_unions_without_const() {
        let projected = project_tool_schema(&schedule_schema(), GeminiToolSchemaDialect::PublicApi);
        assert!(!contains_schema_keyword(&projected, "const", false));
        assert!(!contains_schema_keyword(&projected, "oneOf", false));
        assert!(!contains_schema_keyword(
            &projected,
            "additionalProperties",
            false
        ));
        assert_eq!(projected["required"], json!(["operations"]));
        assert_eq!(
            projected["properties"]["operations"]["items"]["properties"]["op"]["enum"],
            json!(["inspect", "pause"])
        );
        assert!(projected["properties"]["operations"]["items"]["properties"]
            .get("expected_revision")
            .is_some());
    }

    #[test]
    fn antigravity_moves_discriminators_and_constraints_to_hints() {
        let projected =
            project_tool_schema(&schedule_schema(), GeminiToolSchemaDialect::Antigravity);
        assert!(!contains_schema_keyword(&projected, "const", false));
        assert!(!contains_schema_keyword(&projected, "enum", false));
        assert!(!contains_schema_keyword(&projected, "oneOf", false));
        let operation = &projected["properties"]["operations"];
        assert!(operation["description"]
            .as_str()
            .is_some_and(|description| description.contains("minimum items: 1")));
        assert!(operation["items"]["properties"]["op"]["description"]
            .as_str()
            .is_some_and(|description| {
                description.contains("inspect") && description.contains("pause")
            }));
    }

    #[test]
    fn projection_never_rewrites_property_names_that_match_schema_keywords() {
        let request = json!({
            "tools": [{
                "functionDeclarations": [{
                    "name": "record",
                    "parametersJsonSchema": {
                        "type": "object",
                        "properties": {
                            "const": {"type": "string"},
                            "default": {"type": "string"},
                            "format": {"type": "string"},
                            "title": {"type": "string"}
                        }
                    }
                }]
            }],
            "contents": [{
                "role": "model",
                "parts": [{"functionCall": {"name": "record", "args": {
                    "const": "kept", "default": "kept", "format": "kept", "title": "kept"
                }}}]
            }]
        });
        let projected =
            project_request_tool_schemas(request.clone(), GeminiToolSchemaDialect::Antigravity);
        assert_eq!(projected["contents"], request["contents"]);
        let properties =
            &projected["tools"][0]["functionDeclarations"][0]["parameters"]["properties"];
        for name in ["const", "default", "format", "title"] {
            assert!(properties.get(name).is_some(), "missing property {name}");
        }
    }

    #[test]
    fn projection_resolves_local_refs_merges_all_of_and_repairs_array_items() {
        let schema = json!({
            "$defs": {
                "Config": {
                    "type": "object",
                    "allOf": [
                        {
                            "properties": {"name": {"type": "string"}},
                            "required": ["name"]
                        },
                        {
                            "properties": {"tags": {"type": "array"}},
                            "required": ["tags"]
                        }
                    ]
                }
            },
            "type": "object",
            "properties": {
                "config": {
                    "$ref": "#/$defs/Config",
                    "description": "Configuration to apply"
                }
            },
            "required": ["config"]
        });
        let projected = project_tool_schema(&schema, GeminiToolSchemaDialect::PublicApi);
        let config = &projected["properties"]["config"];
        assert!(!contains_schema_keyword(&projected, "$ref", false));
        assert!(!contains_schema_keyword(&projected, "$defs", false));
        assert!(!contains_schema_keyword(&projected, "allOf", false));
        assert_eq!(config["required"], json!(["name", "tags"]));
        assert_eq!(
            config["properties"]["tags"]["items"],
            json!({"type": "string"})
        );
        assert!(config["description"]
            .as_str()
            .is_some_and(|description| description.contains("Configuration to apply")));
    }
}
