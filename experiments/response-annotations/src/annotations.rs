use morphz::llm::{Response, ToolDefinition};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fmt;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    #[default]
    Off,
    V1,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtocolError(pub String);
impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for ProtocolError {}
fn error(message: &str) -> ProtocolError {
    ProtocolError(message.into())
}
fn diagnostic_path(path: &str) -> String {
    let mut characters = path.chars();
    let mut bounded: String = characters.by_ref().take(255).collect();
    if characters.next().is_some() {
        bounded.push('…');
    }
    bounded
}

pub fn annotation_schema() -> Value {
    json!({"type":"object", "additionalProperties":false, "properties":{
        "execution":{"type":"object", "additionalProperties":false, "properties":{
            "title":{"type":"string", "maxLength":256},
            "progress":{"type":"string", "maxLength":256},
            "result":{"type":"string", "maxLength":512}
        }},
        "intent":{"type":"string", "maxLength":256},
        "observations":{"type":"array", "maxItems":16, "items":{
            "type":"object", "additionalProperties":false, "required":["ref","result"],
            "properties":{"ref":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[\\x00-\\x7F]+$"},
                "result":{"type":"string","maxLength":512}}
        }}
    }})
}

/// A candidate model-visible schema only. Strict/nullable provider adaptation
/// still needs real-provider validation; original business schemas are kept.
pub fn augment_tools(
    tools: &[ToolDefinition],
    protocol: Protocol,
    typed_infer: bool,
) -> Result<Vec<ToolDefinition>, ProtocolError> {
    if protocol == Protocol::Off || typed_infer {
        return Ok(tools.to_vec());
    }
    for tool in tools {
        if tool.name == "reply" {
            return Err(error("Reserved reply tool name is occupied"));
        }
        let parameters = &tool.parameters;
        if parameters
            .get("properties")
            .and_then(Value::as_object)
            .is_some_and(|p| p.contains_key("_annotations"))
            || parameters
                .get("required")
                .and_then(Value::as_array)
                .is_some_and(|r| r.iter().any(|v| v.as_str() == Some("_annotations")))
        {
            return Err(error("Reserved _annotations parameter is occupied"));
        }
        if tool.name == "no_reply" {
            continue;
        }
        if parameters.get("type").and_then(Value::as_str) != Some("object")
            || parameters.get("properties").is_some_and(|p| !p.is_object())
        {
            return Err(error("Root object tool schema required"));
        }
        if ["$ref", "allOf", "anyOf", "oneOf"]
            .iter()
            .any(|key| parameters.get(*key).is_some())
        {
            return Err(error(
                "Composite root schema needs explicit integration decision",
            ));
        }
    }
    let mut augmented = tools.to_vec();
    for tool in &mut augmented {
        if tool.name == "no_reply" {
            continue;
        }
        tool.parameters
            .as_object_mut()
            .unwrap()
            .entry("properties")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .unwrap()
            .insert("_annotations".into(), annotation_schema());
    }
    augmented.push(ToolDefinition {
        name: "reply".into(),
        description: "Deliver the final user-facing response. Use alone. Optional annotations do not change execution state; this is not a work tool.".into(),
        parameters: json!({"type":"object", "additionalProperties":false, "required":["content"],
            "properties":{"content":{"type":"string","minLength":1},"annotations":annotation_schema()}}),
    });
    Ok(augmented)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionScope {
    pub execution_id: String,
    pub generation: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Producer {
    pub event_id: String,
    pub attempt_id: String,
    /// Trusted persisted event order. Never derive this from model refs.
    pub sequence: Option<u64>,
}
#[derive(Clone, Debug)]
pub struct TrustedObservation {
    pub event_id: String,
    pub scope: ExecutionScope,
    pub provided: bool,
    pub allowed: bool,
}
#[derive(Clone, Debug)]
pub struct ExecutionFact {
    pub scope: ExecutionScope,
    pub status: String,
    pub terminal: bool,
    pub terminal_sequence: Option<u64>,
}
#[derive(Clone, Debug, Default)]
pub struct NormalizationContext {
    /// Must be the version frozen for this execution, not mutable global config.
    pub protocol: Protocol,
    pub typed_infer: bool,
    pub scope: Option<ExecutionScope>,
    pub producer: Option<Producer>,
    pub observations: HashMap<String, TrustedObservation>,
    pub execution_fact: Option<ExecutionFact>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum AnnotationKind {
    #[serde(rename = "execution.title")]
    Title,
    #[serde(rename = "execution.progress")]
    Progress,
    #[serde(rename = "execution.result")]
    Result,
    #[serde(rename = "intent")]
    Intent,
    #[serde(rename = "observation.result")]
    ObservationResult,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnnotationRecord {
    /// Collision-free structured producer key; not an independently minted ID.
    pub identity: String,
    pub protocol: Protocol,
    pub kind: AnnotationKind,
    pub value: String,
    pub source: Producer,
    pub ordinal: usize,
    pub scope: ExecutionScope,
    pub call_id: Option<String>,
    pub observation_ref: Option<String>,
    pub observation_event_id: Option<String>,
    /// A delivery alone does not prove the execution truly terminated.
    pub effective: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Diagnostic {
    pub path: String,
    pub message: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NoReplyMode {
    Silent,
    Wait {
        wait_secs: u64,
        explicitly_requested: bool,
    },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TerminalDecision {
    Deliver(String),
    NoReply(NoReplyMode),
}
#[derive(Clone, Debug)]
pub struct NormalizedResponse {
    pub raw_response: Response,
    pub execution_response: Response,
    /// Protocol applied to this response, not the authoritative frozen execution
    /// version (typed infer bypasses v1 without changing the execution binding).
    pub protocol: Protocol,
    pub records: Vec<AnnotationRecord>,
    pub diagnostics: Vec<Diagnostic>,
    pub omitted_diagnostics: usize,
    pub terminal_decision: Option<TerminalDecision>,
    pub dispatch_allowed: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReplyArguments {
    pub content: String,
    // Preserve Some(Null) so an explicitly malformed metadata container still
    // produces a diagnostic; absence remains None. Derive rejects duplicates.
    #[serde(default, deserialize_with = "present_value")]
    pub annotations: Option<Value>,
}
fn present_value<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}
pub(crate) fn parse_reply_arguments(arguments: &str) -> Result<ReplyArguments, ProtocolError> {
    let reply: ReplyArguments = serde_json::from_str(arguments)
        .map_err(|_| error("Malformed, duplicate or unknown reply control field"))?;
    if reply.content.trim().is_empty() {
        return Err(error("Invalid reply content"));
    }
    Ok(reply)
}

fn terminal(response: &Response) -> Result<Option<TerminalDecision>, ProtocolError> {
    if response
        .tool_calls
        .iter()
        .any(|c| c.func_name == "no_reply")
    {
        if response.tool_calls.len() != 1 || !response.content.trim().is_empty() {
            return Err(error("no_reply must be sole call with no ordinary content"));
        }
        let args: Value = serde_json::from_str(&response.tool_calls[0].arguments)
            .map_err(|_| error("Malformed no_reply control JSON"))?;
        let args = args
            .as_object()
            .ok_or_else(|| error("no_reply arguments must be an object"))?;
        if args.keys().any(|k| k != "mode" && k != "wait_secs") {
            return Err(error("Unknown no_reply control parameters"));
        }
        let mode = match args.get("mode").and_then(Value::as_str) {
            Some("silent") if !args.contains_key("wait_secs") => NoReplyMode::Silent,
            Some("wait") => {
                let explicitly_requested = args.contains_key("wait_secs");
                let wait_secs = match args.get("wait_secs") {
                    Some(v) => v
                        .as_u64()
                        .filter(|v| *v > 0)
                        .ok_or_else(|| error("wait_secs must be a positive u64"))?,
                    None => 60,
                };
                NoReplyMode::Wait {
                    wait_secs,
                    explicitly_requested,
                }
            }
            _ => return Err(error("Invalid no_reply control mode")),
        };
        return Ok(Some(TerminalDecision::NoReply(mode)));
    }
    if !response.tool_calls.is_empty() {
        return Ok(None);
    }
    if response.content.trim().is_empty() {
        return Err(error("Empty terminal reply"));
    }
    Ok(Some(TerminalDecision::Deliver(response.content.clone())))
}

struct Extraction<'a> {
    context: &'a NormalizationContext,
    records: Vec<AnnotationRecord>,
    diagnostics: Vec<Diagnostic>,
    omitted_diagnostics: usize,
    execution_seen: bool,
    observation_inputs_seen: usize,
}
impl<'a> Extraction<'a> {
    fn new(context: &'a NormalizationContext) -> Self {
        Self {
            context,
            records: vec![],
            diagnostics: vec![],
            omitted_diagnostics: 0,
            execution_seen: false,
            observation_inputs_seen: 0,
        }
    }
    fn note(&mut self, path: &str, message: &str) {
        if self.diagnostics.len() < 64 {
            self.diagnostics.push(Diagnostic {
                path: diagnostic_path(path),
                message: message.into(),
            });
        } else {
            self.omitted_diagnostics += 1;
        }
    }
    fn text(&mut self, value: &Value, max: usize, path: &str) -> Option<String> {
        let Some(text) = value
            .as_str()
            .filter(|text| text.chars().take(max + 1).count() <= max)
        else {
            self.note(path, "Invalid or over-limit annotation text");
            return None;
        };
        if text.trim().is_empty() {
            self.note(path, "Empty annotation does not erase prior text");
            return None;
        }
        Some(text.into())
    }
    fn record(
        &mut self,
        kind: AnnotationKind,
        value: String,
        path: &str,
        call_id: Option<&str>,
        observation: Option<(&str, &str)>,
        effective: bool,
    ) {
        let (Some(scope), Some(source)) = (&self.context.scope, &self.context.producer) else {
            self.note(path, "Missing trusted producer/scope");
            return;
        };
        if scope.execution_id.is_empty()
            || source.event_id.is_empty()
            || source.attempt_id.is_empty()
        {
            self.note(path, "Missing trusted producer/scope");
            return;
        }
        let identity = json!([
            source.event_id,
            source.attempt_id,
            scope.execution_id,
            scope.generation,
            call_id,
            path
        ])
        .to_string();
        self.records.push(AnnotationRecord {
            identity,
            protocol: Protocol::V1,
            kind,
            value,
            source: source.clone(),
            ordinal: self.records.len(),
            scope: scope.clone(),
            call_id: call_id.map(str::to_string),
            observation_ref: observation.map(|(r, _)| r.into()),
            observation_event_id: observation.map(|(_, e)| e.into()),
            effective,
        });
    }
    fn extract(
        &mut self,
        value: &Value,
        path: &str,
        call_id: Option<&str>,
        terminal_carrier: bool,
    ) {
        let Some(annotations) = value.as_object() else {
            self.note(path, "Annotation container must be an object");
            return;
        };
        for key in annotations.keys() {
            if !["execution", "intent", "observations"].contains(&key.as_str()) {
                self.note(&format!("{path}.{key}"), "Unknown annotation field ignored");
            }
        }
        if let Some(execution) = annotations.get("execution") {
            if let Some(execution) = execution.as_object() {
                if self.execution_seen {
                    self.note(
                        &format!("{path}.execution"),
                        "Only one execution annotation allowed per response",
                    );
                } else {
                    for (key, value) in execution {
                        let item_path = format!("{path}.execution.{key}");
                        let (kind, max) = match key.as_str() {
                            "title" => (AnnotationKind::Title, 256),
                            "progress" => (AnnotationKind::Progress, 256),
                            "result" => (AnnotationKind::Result, 512),
                            _ => {
                                self.note(&item_path, "Unknown execution annotation field ignored");
                                continue;
                            }
                        };
                        let Some(text) = self.text(value, max, &item_path) else {
                            continue;
                        };
                        if kind == AnnotationKind::Result && !terminal_carrier {
                            self.note(&item_path, "Working response cannot establish final result");
                            continue;
                        }
                        self.execution_seen = true;
                        let effective = kind != AnnotationKind::Result
                            || self.context.execution_fact.as_ref().is_some_and(|fact| {
                                Some(&fact.scope) == self.context.scope.as_ref()
                                    && fact.terminal
                                    && fact.status != "cancelled"
                            });
                        self.record(kind, text, &item_path, None, None, effective);
                    }
                }
            } else {
                self.note(
                    &format!("{path}.execution"),
                    "Invalid execution annotation object",
                );
            }
        }
        if let Some(intent) = annotations.get("intent") {
            let item_path = format!("{path}.intent");
            if let Some(text) = self.text(intent, 256, &item_path) {
                if let Some(call_id) = call_id {
                    self.record(
                        AnnotationKind::Intent,
                        text,
                        &item_path,
                        Some(call_id),
                        None,
                        true,
                    );
                } else {
                    self.note(&item_path, "Terminal response has no work-call intent");
                }
            }
        }
        if let Some(observations) = annotations.get("observations") {
            if let Some(observations) = observations.as_array() {
                let remaining = 16usize.saturating_sub(self.observation_inputs_seen);
                if observations.len() > remaining {
                    self.note(
                        &format!("{path}.observations"),
                        "Response observation limit exceeded",
                    );
                }
                self.observation_inputs_seen = self
                    .observation_inputs_seen
                    .saturating_add(observations.len());
                for (index, observation) in observations.iter().take(remaining).enumerate() {
                    let item_path = format!("{path}.observations[{index}]");
                    let Some(observation) = observation.as_object() else {
                        self.note(&item_path, "Invalid observation object");
                        continue;
                    };
                    for key in observation.keys() {
                        if key != "ref" && key != "result" {
                            self.note(
                                &format!("{item_path}.{key}"),
                                "Unknown observation field ignored",
                            );
                        }
                    }
                    let Some(reference) = observation
                        .get("ref")
                        .and_then(Value::as_str)
                        .filter(|r| !r.is_empty() && r.len() <= 128 && r.is_ascii())
                    else {
                        self.note(&format!("{item_path}.ref"), "Invalid observation ref");
                        continue;
                    };
                    let Some(text) = self.text(
                        observation.get("result").unwrap_or(&Value::Null),
                        512,
                        &format!("{item_path}.result"),
                    ) else {
                        continue;
                    };
                    let target = self.context.observations.get(reference).filter(|target| {
                        target.provided
                            && target.allowed
                            && !target.event_id.is_empty()
                            && Some(&target.scope) == self.context.scope.as_ref()
                    });
                    if let Some(target) = target {
                        self.record(
                            AnnotationKind::ObservationResult,
                            text,
                            &format!("{item_path}.result"),
                            None,
                            Some((reference, &target.event_id)),
                            true,
                        );
                    } else {
                        self.note(
                            &format!("{item_path}.ref"),
                            "Observation not provided or outside trusted execution scope",
                        );
                    }
                }
            } else {
                self.note(
                    &format!("{path}.observations"),
                    "Observations must be an array",
                );
            }
        }
    }
}

pub fn normalize_response(
    response: &Response,
    context: &NormalizationContext,
) -> Result<NormalizedResponse, ProtocolError> {
    if context.protocol == Protocol::Off || context.typed_infer {
        return Ok(NormalizedResponse {
            raw_response: response.clone(),
            execution_response: response.clone(),
            protocol: Protocol::Off,
            records: vec![],
            diagnostics: vec![],
            omitted_diagnostics: 0,
            terminal_decision: None,
            dispatch_allowed: true,
        });
    }
    let reply = response
        .tool_calls
        .iter()
        .find(|call| call.func_name == "reply");
    if reply.is_some() && (response.tool_calls.len() != 1 || !response.content.trim().is_empty()) {
        return Err(error("reply must be sole call with no ordinary content"));
    }
    let mut extraction = Extraction::new(context);
    let mut execution_response = response.clone();
    if response
        .tool_calls
        .iter()
        .any(|call| call.func_name == "no_reply")
    {
        // Do not strip or accept annotations in the legacy control grammar.
        terminal(response)?;
    } else if let Some(reply) = reply {
        let args = parse_reply_arguments(&reply.arguments)?;
        if let Some(annotations) = &args.annotations {
            extraction.extract(annotations, "reply.annotations", None, true);
        }
        execution_response.content = args.content;
        execution_response.tool_calls.clear();
    } else {
        for (index, call) in execution_response.tool_calls.iter_mut().enumerate() {
            let mut args: Value = match serde_json::from_str(&call.arguments) {
                Ok(args) => args,
                Err(_) => {
                    extraction.note(
                        &format!("tool_calls[{index}]"),
                        "Business arguments unchanged; original validation remains authoritative",
                    );
                    continue;
                }
            };
            if let Some(annotations) = args
                .as_object_mut()
                .and_then(|args| args.remove("_annotations"))
            {
                extraction.extract(
                    &annotations,
                    &format!("tool_calls[{index}]._annotations"),
                    Some(&call.id),
                    false,
                );
                call.arguments = args.to_string();
            }
        }
    }
    let terminal_decision = terminal(&execution_response)?;
    let dispatch_allowed = !context.execution_fact.as_ref().is_some_and(|fact| {
        Some(&fact.scope) == context.scope.as_ref() && fact.status == "cancelled"
    });
    Ok(NormalizedResponse {
        raw_response: response.clone(),
        execution_response,
        protocol: Protocol::V1,
        records: extraction.records,
        diagnostics: extraction.diagnostics,
        omitted_diagnostics: extraction.omitted_diagnostics,
        terminal_decision,
        dispatch_allowed,
    })
}

pub fn merge_records(
    existing: &[AnnotationRecord],
    incoming: &[AnnotationRecord],
) -> (Vec<AnnotationRecord>, Vec<String>) {
    let mut records = existing.to_vec();
    let mut indices: HashMap<String, usize> = records
        .iter()
        .enumerate()
        .map(|(i, r)| (r.identity.clone(), i))
        .collect();
    let mut conflicts = vec![];
    for record in incoming {
        match indices.get(&record.identity) {
            Some(index) if records[*index] != *record => conflicts.push(record.identity.clone()),
            Some(_) => (),
            None => {
                indices.insert(record.identity.clone(), records.len());
                records.push(record.clone());
            }
        }
    }
    (records, conflicts)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionProjection {
    pub status: String,
    pub title: Option<String>,
    pub progress: Option<String>,
    pub result: Option<String>,
}
pub fn project_execution(
    fact: &ExecutionFact,
    records: &[AnnotationRecord],
) -> ExecutionProjection {
    let mut matching: Vec<_> = records
        .iter()
        .filter(|record| {
            record.scope == fact.scope
                && record.source.sequence.is_some()
                && (!fact.terminal
                    || fact.terminal_sequence.is_none()
                    || record.source.sequence <= fact.terminal_sequence)
        })
        .collect();
    matching.sort_by_key(|record| (record.source.sequence, record.ordinal));
    let last = |kind| {
        matching
            .iter()
            .rev()
            .find(|r| r.kind == kind)
            .map(|r| r.value.clone())
    };
    ExecutionProjection {
        status: fact.status.clone(),
        // V1 has no rename operation: later titles stay in the audit records.
        title: matching
            .iter()
            .find(|r| r.kind == AnnotationKind::Title)
            .map(|r| r.value.clone()),
        progress: if fact.terminal {
            None
        } else {
            last(AnnotationKind::Progress)
        },
        result: if fact.terminal && fact.status != "cancelled" {
            matching
                .iter()
                .rev()
                .find(|r| r.kind == AnnotationKind::Result && r.effective)
                .map(|r| r.value.clone())
        } else {
            None
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use morphz::llm::ToolCallRepr;
    fn call(id: &str, name: &str, args: Value) -> ToolCallRepr {
        ToolCallRepr {
            id: id.into(),
            r#type: "function".into(),
            func_name: name.into(),
            arguments: args.to_string(),
        }
    }
    fn response(calls: Vec<ToolCallRepr>) -> Response {
        Response {
            content: String::new(),
            tool_calls: calls,
        }
    }
    fn tool() -> ToolDefinition {
        ToolDefinition {
            name: "exec".into(),
            description: "Synthetic".into(),
            parameters: json!({"type":"object","additionalProperties":false,"required":["command"],"properties":{"command":{"type":"string"},"payload":{"type":"object"}}}),
        }
    }
    fn context() -> NormalizationContext {
        let scope = ExecutionScope {
            execution_id: "execution-1".into(),
            generation: 3,
        };
        let mut observations = HashMap::new();
        observations.insert(
            "@e123".into(),
            TrustedObservation {
                event_id: "event-123".into(),
                scope: scope.clone(),
                provided: true,
                allowed: true,
            },
        );
        observations.insert(
            "@future".into(),
            TrustedObservation {
                event_id: "future-event".into(),
                scope: scope.clone(),
                provided: false,
                allowed: true,
            },
        );
        observations.insert(
            "@other".into(),
            TrustedObservation {
                event_id: "other-event".into(),
                scope: ExecutionScope {
                    execution_id: "other".into(),
                    generation: 3,
                },
                provided: true,
                allowed: true,
            },
        );
        observations.insert(
            "@old".into(),
            TrustedObservation {
                event_id: "old-event".into(),
                scope: ExecutionScope {
                    execution_id: "execution-1".into(),
                    generation: 2,
                },
                provided: true,
                allowed: true,
            },
        );
        NormalizationContext {
            protocol: Protocol::V1,
            scope: Some(scope),
            producer: Some(Producer {
                event_id: "response-event".into(),
                attempt_id: "attempt".into(),
                sequence: Some(9),
            }),
            observations,
            ..Default::default()
        }
    }
    #[test]
    fn runtime_style_baseline_off_serialized_response_schema_and_stream_contract_unchanged() {
        let tools = vec![ToolDefinition {
            name: "reply".into(),
            ..tool()
        }];
        assert_eq!(
            serde_json::to_vec(&tools).unwrap(),
            serde_json::to_vec(&augment_tools(&tools, Protocol::Off, false).unwrap()).unwrap()
        );
        let raw = response(vec![call(
            "1",
            "reply",
            json!({"command":"business", "_annotations":{"business":true}}),
        )]);
        let normalized = normalize_response(&raw, &NormalizationContext::default()).unwrap();
        assert_eq!(
            serde_json::to_vec(&raw).unwrap(),
            serde_json::to_vec(&normalized.execution_response).unwrap()
        );
        assert!(normalized.records.is_empty());
        assert!(normalized.terminal_decision.is_none());
        let mut typed = context();
        typed.typed_infer = true;
        assert_eq!(
            serde_json::to_vec(&raw).unwrap(),
            serde_json::to_vec(&normalize_response(&raw, &typed).unwrap().execution_response)
                .unwrap()
        );
    }
    #[test]
    fn schema_additive_optional_and_collisions_refused() {
        let original = tool();
        let before = serde_json::to_vec(&original).unwrap();
        let augmented = augment_tools(&[original.clone()], Protocol::V1, false).unwrap();
        assert_eq!(before, serde_json::to_vec(&original).unwrap());
        assert_eq!(augmented[0].parameters["required"], json!(["command"]));
        assert_eq!(
            augmented[0].parameters["properties"]["command"],
            original.parameters["properties"]["command"]
        );
        assert_eq!(augmented[1].name, "reply");
        assert!(augment_tools(
            &[ToolDefinition {
                name: "reply".into(),
                ..original.clone()
            }],
            Protocol::V1,
            false
        )
        .is_err());
        let mut occupied = original;
        occupied.parameters["properties"]["_annotations"] = json!({});
        assert!(augment_tools(&[occupied], Protocol::V1, false).is_err());
    }
    #[test]
    fn work_args_raw_and_nested_business_fields_preserved_precise_refs_only() {
        let args = json!({"command":"printf '中文\\n' \"$UNCHANGED\"", "payload":{"_annotations":{"business":true}},"_annotations":{
            "execution":{"title":"检查环境","result":"不能提前完成"},"intent":"确认架构","observations":[
                {"ref":"@e123","result":"Linux"},{"ref":"@future","result":"future"},{"ref":"@other","result":"other"},{"ref":"@old","result":"old"}]}});
        let raw = response(vec![call("provider-id", "exec", args.clone())]);
        let normalized = normalize_response(&raw, &context()).unwrap();
        assert_eq!(
            raw.tool_calls[0].arguments,
            normalized.raw_response.tool_calls[0].arguments
        );
        let mut expected = args;
        expected.as_object_mut().unwrap().remove("_annotations");
        assert_eq!(
            serde_json::from_str::<Value>(&normalized.execution_response.tool_calls[0].arguments)
                .unwrap(),
            expected
        );
        assert_eq!(normalized.records.len(), 3);
        assert!(normalized.terminal_decision.is_none());
        let intent = normalized
            .records
            .iter()
            .find(|r| r.kind == AnnotationKind::Intent)
            .unwrap();
        assert_eq!(intent.call_id.as_deref(), Some("provider-id"));
        let observation = normalized
            .records
            .iter()
            .find(|r| r.kind == AnnotationKind::ObservationResult)
            .unwrap();
        assert_eq!(
            observation.observation_event_id.as_deref(),
            Some("event-123")
        );
    }
    #[test]
    fn batch_global_observation_limit_and_per_call_intents() {
        let observations: Vec<_> = (0..16)
            .map(|_| json!({"ref":"@e123","result":"有效"}))
            .collect();
        let raw = response((0..2).map(|i| call(&format!("call-{i}"), "exec", json!({"command":"x", "_annotations":{"intent":format!("step-{i}"),"execution":{"title":format!("title-{i}")},"observations":observations}}))).collect());
        let normalized = normalize_response(&raw, &context()).unwrap();
        assert_eq!(
            normalized
                .records
                .iter()
                .filter(|r| r.kind == AnnotationKind::ObservationResult)
                .count(),
            16
        );
        assert_eq!(
            normalized
                .records
                .iter()
                .filter(|r| r.kind == AnnotationKind::Intent)
                .count(),
            2
        );
        assert_eq!(
            normalized
                .records
                .iter()
                .filter(|r| r.kind == AnnotationKind::Title)
                .count(),
            1
        );
    }
    #[test]
    fn malformed_metadata_fallback_unicode_limit_and_diagnostics_bounded() {
        let raw = response(vec![call(
            "1",
            "exec",
            json!({"command":"x","_annotations":{"execution":{"title":"🧠".repeat(256),"progress":"🧠".repeat(257),"status":"success"},"intent":12,"observations":[{"ref":"@e123","result":"有效"}]}}),
        )]);
        let normalized = normalize_response(&raw, &context()).unwrap();
        assert_eq!(normalized.records.len(), 2);
        assert_eq!(normalized.execution_response.tool_calls.len(), 1);
        let mut unknown = serde_json::Map::new();
        for i in 0..100 {
            unknown.insert(format!("unknown-{i}"), Value::Null);
        }
        let excessive = normalize_response(
            &response(vec![call(
                "2",
                "exec",
                json!({"command":"x","_annotations":unknown}),
            )]),
            &context(),
        )
        .unwrap();
        assert_eq!(excessive.diagnostics.len(), 64);
        assert_eq!(excessive.omitted_diagnostics, 36);
    }
    #[test]
    fn oversized_unknown_keys_keep_diagnostics_bounded_without_changing_business_action() {
        let mut unknown = serde_json::Map::new();
        for index in 0..100 {
            unknown.insert(format!("{}{index}", "🧠".repeat(1000)), Value::Null);
        }
        let raw = response(vec![call(
            "work",
            "exec",
            json!({"command":"unchanged","payload":{"_annotations":"business"},"_annotations":unknown}),
        )]);
        let normalized = normalize_response(&raw, &context()).unwrap();
        assert_eq!(normalized.diagnostics.len(), 64);
        assert_eq!(normalized.omitted_diagnostics, 36);
        assert!(normalized.diagnostics.iter().all(|diagnostic| {
            diagnostic.path.chars().count() <= 256 && diagnostic.path.ends_with('…')
        }));
        assert_eq!(
            normalized.raw_response.tool_calls[0].arguments,
            raw.tool_calls[0].arguments
        );
        assert_eq!(
            serde_json::from_str::<Value>(&normalized.execution_response.tool_calls[0].arguments)
                .unwrap(),
            json!({"command":"unchanged","payload":{"_annotations":"business"}})
        );
        assert!(normalized.terminal_decision.is_none());
        assert!(normalized.records.is_empty());
    }
    #[test]
    fn reply_same_response_terminal_mapping_and_control_failures() {
        let raw = response(vec![call(
            "r",
            "reply",
            json!({"content":"检查完成。","annotations":{"execution":{"result":"已确认"}}}),
        )]);
        let normalized = normalize_response(&raw, &context()).unwrap();
        assert!(normalized.execution_response.tool_calls.is_empty());
        assert_eq!(
            normalized.terminal_decision,
            Some(TerminalDecision::Deliver("检查完成。".into()))
        );
        assert!(!normalized.records[0].effective);
        let mut completed = context();
        completed.execution_fact = Some(ExecutionFact {
            scope: completed.scope.clone().unwrap(),
            status: "completed".into(),
            terminal: true,
            terminal_sequence: Some(9),
        });
        assert!(normalize_response(&raw, &completed).unwrap().records[0].effective);
        let bad_metadata = normalize_response(
            &response(vec![call(
                "r",
                "reply",
                json!({"content":"正文","annotations":null}),
            )]),
            &context(),
        )
        .unwrap();
        assert!(bad_metadata.records.is_empty());
        assert_eq!(bad_metadata.execution_response.content, "正文");
        assert!(normalize_response(
            &response(vec![
                call("r", "reply", json!({"content":"x"})),
                call("w", "exec", json!({"command":"x"}))
            ]),
            &context()
        )
        .is_err());
        assert!(normalize_response(
            &response(vec![call(
                "r",
                "reply",
                json!({"content":"", "status":"success"})
            )]),
            &context()
        )
        .is_err());
    }
    #[test]
    fn no_reply_bound_mode_and_u64_range_unchanged_no_annotations() {
        let default = normalize_response(
            &response(vec![call("n", "no_reply", json!({"mode":"wait"}))]),
            &context(),
        )
        .unwrap();
        assert_eq!(
            default.terminal_decision,
            Some(TerminalDecision::NoReply(NoReplyMode::Wait {
                wait_secs: 60,
                explicitly_requested: false
            }))
        );
        let explicit = normalize_response(
            &response(vec![call(
                "n",
                "no_reply",
                json!({"mode":"wait","wait_secs":u64::MAX}),
            )]),
            &context(),
        )
        .unwrap();
        assert_eq!(
            explicit.terminal_decision,
            Some(TerminalDecision::NoReply(NoReplyMode::Wait {
                wait_secs: u64::MAX,
                explicitly_requested: true
            }))
        );
        assert!(normalize_response(
            &response(vec![call(
                "n",
                "no_reply",
                json!({"mode":"silent","_annotations":{}})
            )]),
            &context()
        )
        .is_err());
        assert!(normalize_response(
            &response(vec![call(
                "n",
                "no_reply",
                json!({"mode":"wait","wait_secs":0})
            )]),
            &context()
        )
        .is_err());
    }
    #[test]
    fn reply_duplicate_control_fields_are_rejected_but_null_metadata_downgrades() {
        for args in [
            r#"{"content":"one","content":"two"}"#,
            r#"{"content":"正文","annotations":{},"annotations":{}}"#,
        ] {
            let raw = response(vec![ToolCallRepr {
                id: "r".into(),
                r#type: "function".into(),
                func_name: "reply".into(),
                arguments: args.into(),
            }]);
            assert!(normalize_response(&raw, &context()).is_err());
        }
        let raw = response(vec![call(
            "r",
            "reply",
            json!({"content":"正文","annotations":null}),
        )]);
        let normalized = normalize_response(&raw, &context()).unwrap();
        assert_eq!(normalized.execution_response.content, "正文");
        assert_eq!(normalized.diagnostics.len(), 1);
    }
    #[test]
    fn other_execution_fact_cannot_mark_result_effective_or_cancel_current_execution() {
        let mut ctx = context();
        ctx.execution_fact = Some(ExecutionFact {
            scope: ExecutionScope {
                execution_id: "other-execution".into(),
                generation: 3,
            },
            status: "cancelled".into(),
            terminal: true,
            terminal_sequence: Some(9),
        });
        let raw = response(vec![call(
            "r",
            "reply",
            json!({"content":"正文","annotations":{"execution":{"result":"结果"}}}),
        )]);
        let normalized = normalize_response(&raw, &ctx).unwrap();
        assert!(normalized.dispatch_allowed);
        assert!(!normalized.records[0].effective);
        ctx.execution_fact.as_mut().unwrap().status = "completed".into();
        assert!(!normalize_response(&raw, &ctx).unwrap().records[0].effective);
    }
    #[test]
    fn replay_idempotent_and_conflicting_rebind_rejected() {
        let raw = response(vec![call(
            "1",
            "exec",
            json!({"command":"x","_annotations":{"observations":[{"ref":"@e123","result":"Linux"}]}}),
        )]);
        let first = normalize_response(&raw, &context()).unwrap();
        let repeated = normalize_response(&raw, &context()).unwrap();
        let (merged, conflicts) = merge_records(&first.records, &repeated.records);
        assert_eq!(merged.len(), 1);
        assert!(conflicts.is_empty());
        let mut changed = repeated.records;
        changed[0].observation_event_id = Some("forged".into());
        assert_eq!(merge_records(&first.records, &changed).1.len(), 1);
    }
    #[test]
    fn projection_trusted_sequence_effective_result_cancel_and_late_facts() {
        let mut ctx = context();
        ctx.execution_fact = Some(ExecutionFact {
            scope: ctx.scope.clone().unwrap(),
            status: "completed".into(),
            terminal: true,
            terminal_sequence: Some(30),
        });
        let raw = response(vec![call(
            "r",
            "reply",
            json!({"content":"正文","annotations":{"execution":{"title":"标题","progress":"进展","result":"结果"}}}),
        )]);
        let mut records = normalize_response(&raw, &ctx).unwrap().records;
        let fact = ctx.execution_fact.clone().unwrap();
        let completed = project_execution(&fact, &records);
        assert_eq!(completed.result.as_deref(), Some("结果"));
        assert!(completed.progress.is_none());
        let mut late = records.clone();
        for r in &mut late {
            r.source.sequence = Some(40);
            r.value = "迟到".into();
        }
        records.extend(late);
        assert_eq!(
            project_execution(&fact, &records).result.as_deref(),
            Some("结果")
        );
        for r in &mut records {
            r.effective = false;
        }
        assert!(project_execution(&fact, &records).result.is_none());
        let cancelled = ExecutionFact {
            status: "cancelled".into(),
            ..fact
        };
        assert!(project_execution(&cancelled, &records).result.is_none());
        let mut cancel_context = context();
        cancel_context.execution_fact = Some(cancelled);
        assert!(
            !normalize_response(&raw, &cancel_context)
                .unwrap()
                .dispatch_allowed
        );
    }
    #[test]
    fn v1_first_valid_title_survives_reordering_later_steps_terminal_and_replay() {
        let produce = |sequence, execution: Value, terminal| {
            let mut ctx = context();
            ctx.producer = Some(Producer {
                event_id: format!("event-{sequence}"),
                attempt_id: format!("attempt-{sequence}"),
                sequence: Some(sequence),
            });
            if terminal {
                ctx.execution_fact = Some(ExecutionFact {
                    scope: ctx.scope.clone().unwrap(),
                    status: "completed".into(),
                    terminal: true,
                    terminal_sequence: Some(30),
                });
            }
            let (name, args) = if terminal {
                (
                    "reply",
                    json!({"content":"正文","annotations":{"execution":execution}}),
                )
            } else {
                (
                    "exec",
                    json!({"command":"safe","_annotations":{"execution":execution}}),
                )
            };
            normalize_response(
                &response(vec![call(&format!("call-{sequence}"), name, args)]),
                &ctx,
            )
            .unwrap()
            .records
        };
        let invalid = produce(5, json!({"title":"","progress":"准备"}), false);
        let first = produce(
            10,
            json!({"title":"核对运行环境","progress":"核对操作系统"}),
            false,
        );
        let later = produce(
            20,
            json!({"title":"核对处理器架构","progress":"核对处理器架构"}),
            false,
        );
        let final_records = produce(30, json!({"title":"结束步骤","result":"已核对环境"}), true);
        let late = produce(40, json!({"title":"迟到步骤","result":"迟到结果"}), true);
        let running = ExecutionFact {
            scope: context().scope.unwrap(),
            status: "running".into(),
            terminal: false,
            terminal_sequence: None,
        };
        let mut records: Vec<_> = later
            .iter()
            .chain(&first)
            .chain(&invalid)
            .cloned()
            .collect();
        for _ in 0..2 {
            let projected = project_execution(&running, &records);
            assert_eq!(projected.title.as_deref(), Some("核对运行环境"));
            assert_eq!(projected.progress.as_deref(), Some("核对处理器架构"));
            records.reverse();
        }
        records.extend(final_records);
        let replay: Vec<_> = first.iter().chain(&later).cloned().collect();
        let (mut stored, conflicts) = merge_records(&records, &replay);
        assert!(conflicts.is_empty());
        assert_eq!(
            stored
                .iter()
                .filter(|r| r.kind == AnnotationKind::Title)
                .count(),
            3
        );
        stored.extend(late);
        let mut unsequenced = produce(1, json!({"title":"没有可信顺序"}), false);
        unsequenced[0].source.sequence = None;
        stored.extend(unsequenced);
        assert_eq!(
            stored
                .iter()
                .filter(|r| r.kind == AnnotationKind::Title)
                .count(),
            5
        );
        let completed = ExecutionFact {
            status: "completed".into(),
            terminal: true,
            terminal_sequence: Some(30),
            ..running
        };
        for _ in 0..2 {
            let projected = project_execution(&completed, &stored);
            assert_eq!(projected.title.as_deref(), Some("核对运行环境"));
            assert_eq!(projected.result.as_deref(), Some("已核对环境"));
            assert!(projected.progress.is_none());
            stored.reverse();
        }
    }
}
