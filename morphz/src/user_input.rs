//! Bounded questions and answers at the existing Runtime input boundary.
//! Request bodies are immutable Events; Scheduler dependencies own readiness.
use crate::event::Event;
use crate::llm::{Response, ToolDefinition};
use crate::memory::{
    ThreadActivationRecord, ThreadActivationStatus, ThreadControlState, ThreadKind, ThreadRecord,
};
use crate::scheduler::{
    SchedulerDependencyKind, SchedulerDependencyOwnerKind, SchedulerDependencyRecord,
    SchedulerDependencyStatus,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashSet;

pub const TOOL_NAME: &str = "request_user_input";
pub const REQUEST_TOPIC: &str = "runtime/user_input_requested";
pub const DISPOSITION: &str = "user_input";
const MAX_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UserInputOption {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UserInputQuestion {
    pub id: String,
    pub question: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<UserInputOption>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub multi_select: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RequestUserInput {
    pub questions: Vec<UserInputQuestion>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UserInputAnswer {
    pub question_id: String,
    #[serde(default)]
    pub selected_option_ids: Vec<String>,
    #[serde(default)]
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UserInputReply {
    pub request_id: String,
    pub thread_id: String,
    pub generation: u64,
    pub answers: Vec<UserInputAnswer>,
}

impl UserInputReply {
    /// The caller first proves that `request` is the current pending read
    /// projection under its transaction; this does not confer write authority.
    pub fn answer_text(&self, request: &PendingUserInputRequest) -> Result<String, String> {
        if self.request_id != request.request_id
            || self.thread_id != request.thread_id
            || self.generation != request.thread_generation
        {
            return Err(
                "The question or its execution generation changed; refresh before replying".into(),
            );
        }
        RequestUserInput {
            questions: request.questions.clone(),
        }
        .answer_text(&self.answers)
    }
}

/// Current read projection, never a renderer-owned question or reply ledger.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PendingUserInputRequest {
    pub request_id: String,
    pub thread_id: String,
    pub thread_generation: u64,
    pub session_id: String,
    pub context_id: String,
    pub requested_at: DateTime<Utc>,
    pub questions: Vec<UserInputQuestion>,
    /// Read-side availability only; ingress always revalidates its transaction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_allowed: Option<bool>,
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn is_false(value: &bool) -> bool {
    !value
}

fn text(value: &str, max_chars: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= max_chars && !value.contains('\0')
}

impl RequestUserInput {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=3).contains(&self.questions.len()) {
            return Err("request_user_input requires one to three explicit questions".into());
        }
        if serde_json::to_vec(self)
            .map_err(|error| error.to_string())?
            .len()
            > MAX_BYTES
        {
            return Err("request_user_input exceeds the 32 KiB request limit".into());
        }
        let mut ids = HashSet::new();
        for question in &self.questions {
            if !identifier(&question.id) || !ids.insert(&question.id) {
                return Err("Question IDs must be unique bounded ASCII identifiers".into());
            }
            if !text(&question.question, 2000) {
                return Err(
                    "Each question requires nonempty text of at most 2000 characters".into(),
                );
            }
            if question.options.len() > 8 || (question.multi_select && question.options.len() < 2) {
                return Err(
                    "A question supports at most eight choices; multi-select requires at least two"
                        .into(),
                );
            }
            let mut options = HashSet::new();
            for option in &question.options {
                if !identifier(&option.id) || !options.insert(&option.id) {
                    return Err("Option IDs must be unique bounded ASCII identifiers".into());
                }
                if !text(&option.label, 200)
                    || option
                        .description
                        .as_ref()
                        .is_some_and(|value| !text(value, 1000))
                {
                    return Err("Choices require nonempty bounded labels and descriptions".into());
                }
            }
        }
        Ok(())
    }

    pub fn parse(arguments: &str) -> Result<Self, String> {
        if arguments.len() > MAX_BYTES {
            return Err("request_user_input exceeds the 32 KiB request limit".into());
        }
        let request: Self = serde_json::from_str(arguments).map_err(|error| error.to_string())?;
        request.validate()?;
        Ok(request)
    }

    /// Validate all choices against the immutable request and preserve actual
    /// free text. The caller supplies IDs, never replacement question labels.
    pub fn answer_text(&self, answers: &[UserInputAnswer]) -> Result<String, String> {
        self.validate()?;
        if answers.len() != self.questions.len()
            || serde_json::to_vec(answers)
                .map_err(|error| error.to_string())?
                .len()
                > MAX_BYTES
        {
            return Err("Answer each question once within the 32 KiB answer limit".into());
        }
        let mut ids = HashSet::new();
        for answer in answers {
            if !ids.insert(&answer.question_id)
                || !self
                    .questions
                    .iter()
                    .any(|question| question.id == answer.question_id)
            {
                return Err("Answers contain duplicate or unknown question IDs".into());
            }
        }
        let mut result = Vec::new();
        for question in &self.questions {
            let answer = answers
                .iter()
                .find(|answer| answer.question_id == question.id)
                .ok_or("A question has no answer")?;
            if (!question.multi_select && answer.selected_option_ids.len() > 1)
                || answer.text.chars().count() > 8000
                || answer.text.contains('\0')
            {
                return Err("Invalid selection count or answer text".into());
            }
            let mut selected = HashSet::new();
            let mut labels = Vec::new();
            for id in &answer.selected_option_ids {
                if !selected.insert(id) {
                    return Err("An option was selected more than once".into());
                }
                let option = question
                    .options
                    .iter()
                    .find(|option| option.id == *id)
                    .ok_or("The selected option is not in this question")?;
                labels.push(option.label.as_str());
            }
            if labels.is_empty() && answer.text.trim().is_empty() {
                return Err("An empty form is not an answer".into());
            }
            let mut body = labels.join("\n");
            if !answer.text.trim().is_empty() {
                if !body.is_empty() {
                    body.push('\n');
                }
                body.push_str(&answer.text);
            }
            if self.questions.len() > 1 {
                body = format!("{}\n{body}", question.question);
            }
            result.push(body);
        }
        // The existing Human message envelope trims outer whitespace. Exact
        // free text is retained in the structured answers and native receipt.
        Ok(result.join("\n\n").trim().to_owned())
    }
}

impl PendingUserInputRequest {
    pub fn from_event(event: &Event) -> Result<Self, String> {
        let string = |key: &str| {
            event
                .payload
                .get(key)
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .ok_or_else(|| format!("User input request has no {key}"))
        };
        if event.topic != REQUEST_TOPIC
            || event
                .payload
                .get("disposition")
                .and_then(serde_json::Value::as_str)
                != Some(DISPOSITION)
        {
            return Err("The Event is not a Runtime user input request".into());
        }
        let request: RequestUserInput = serde_json::from_value(json!({
            "questions": event.payload.get("questions").ok_or("User input request has no questions")?
        })).map_err(|error| error.to_string())?;
        request.validate()?;
        let generation = event
            .payload
            .get("thread_generation")
            .and_then(serde_json::Value::as_u64)
            .filter(|value| *value > 0)
            .ok_or("User input request has no valid Thread generation")?;
        Ok(Self {
            request_id: event.id.clone(),
            thread_id: string("thread_id")?,
            thread_generation: generation,
            session_id: string("session_id")?,
            context_id: string("context_id")?,
            requested_at: event.timestamp,
            questions: request.questions,
            reply_allowed: None,
        })
    }

    pub fn owns_thread(&self, thread: &ThreadRecord) -> bool {
        self.thread_id == thread.id
            && self.thread_generation == thread.generation
            && self.session_id == thread.session_id
            && self.context_id == thread.context_id
            && !thread.lifecycle.is_terminal()
    }
}

pub fn request_event_id(activation_id: &str) -> String {
    format!("user_input_{activation_id}")
}

pub fn request_event(
    call: &Event,
    thread: &ThreadRecord,
    request: &RequestUserInput,
) -> Result<Event, String> {
    request.validate()?;
    let activation = call
        .payload
        .get("activation_id")
        .and_then(serde_json::Value::as_str)
        .ok_or("Question call has no Activation")?;
    let calls: Vec<crate::llm::ToolCall> = serde_json::from_value(
        call.payload
            .get("tool_calls")
            .cloned()
            .ok_or("Question has no actual native call")?,
    )
    .map_err(|error| error.to_string())?;
    if calls.len() != 1 {
        return Err("Question has more than one native call".into());
    }
    let mut payload = serde_json::Map::new();
    for key in [
        "activation_id",
        "thread_id",
        "thread_generation",
        "root_turn_id",
        "session_id",
        "context_id",
        "principal_id",
        "response_annotations",
        "objective_id",
        "objective_generation",
        "objective_evaluation_id",
        "objective_revision",
        "objective_evaluation_elapsed_seconds",
        "objective_evaluation_started_at",
        "objective_pending_dependency_id",
    ] {
        if let Some(value) = call.payload.get(key) {
            payload.insert(key.into(), value.clone());
        }
    }
    payload.insert("agent_id".into(), json!(thread.agent_id));
    payload.insert("disposition".into(), json!(DISPOSITION));
    payload.insert("questions".into(), json!(request.questions));
    payload.insert("assistant_call_event_id".into(), json!(call.id));
    payload.insert("tool_call_id".into(), json!(calls[0].id));
    let mut event = Event::new(
        request_event_id(activation),
        "Runtime-UserInput".into(),
        "runtime_control".into(),
        REQUEST_TOPIC.into(),
        payload,
    );
    event.timestamp = call.timestamp;
    validate_request_call(&event, call)?;
    Ok(event)
}

/// A request must refer to a real, immutable native call, not a reconstructed
/// question from conversation prose. This also retains its Provider evidence.
pub fn validate_request_call(event: &Event, call: &Event) -> Result<String, String> {
    if call.topic != "chat/assistant_call"
        || call.payload.get("terminal_outcome") != Some(&json!(true))
        || call.payload.get("outcome_disposition") != Some(&json!(DISPOSITION))
        || event.payload.get("assistant_call_event_id") != Some(&json!(call.id))
        || [
            "activation_id",
            "thread_id",
            "thread_generation",
            "root_turn_id",
            "session_id",
            "context_id",
            "principal_id",
            "objective_id",
            "objective_generation",
            "objective_evaluation_id",
        ]
        .iter()
        .any(|key| event.payload.get(*key) != call.payload.get(*key))
    {
        return Err("User input request has no matching durable native-call boundary".into());
    }
    let calls: Vec<crate::llm::ToolCall> = serde_json::from_value(
        call.payload
            .get("tool_calls")
            .cloned()
            .ok_or("Question call has no native call")?,
    )
    .map_err(|error| error.to_string())?;
    if calls.len() != 1 || calls[0].function.name != TOOL_NAME || calls[0].id.trim().is_empty() {
        return Err("A question requires exactly one identifiable native call".into());
    }
    if event.payload.get("tool_call_id") != Some(&json!(calls[0].id)) {
        return Err("Question native-call identity differs from its durable evidence".into());
    }
    let request = RequestUserInput::parse(&calls[0].function.arguments)?;
    if event.payload.get("questions") != Some(&json!(request.questions)) {
        return Err("Question body differs from its actual native call".into());
    }
    Ok(calls[0].id.clone())
}

pub fn dependency_metadata(event: &Event) -> serde_json::Value {
    json!({
        "source": TOOL_NAME, "request_event_id": event.id,
        "activation_id": event.payload.get("activation_id"),
        "thread_id": event.payload.get("thread_id"),
        "thread_generation": event.payload.get("thread_generation"),
        "context_id": event.payload.get("context_id"),
        "session_id": event.payload.get("session_id"),
        "objective_id": event.payload.get("objective_id"),
        "objective_generation": event.payload.get("objective_generation")
    })
}

pub fn validate_objective_owner(
    event: &Event,
    thread: &ThreadRecord,
    objective: &crate::memory::ObjectiveRecord,
) -> Result<(), String> {
    if objective.status != crate::memory::ObjectiveStatus::Active
        || event
            .payload
            .get("objective_id")
            .and_then(serde_json::Value::as_str)
            != Some(objective.id.as_str())
        || event
            .payload
            .get("objective_generation")
            .and_then(serde_json::Value::as_u64)
            != Some(objective.generation)
        || event
            .payload
            .get("objective_evaluation_id")
            .and_then(serde_json::Value::as_str)
            .is_none()
        || event
            .payload
            .get("objective_evaluation_id")
            .and_then(serde_json::Value::as_str)
            != objective.active_evaluation_id.as_deref()
        || objective.agent_id != thread.agent_id
        || objective.context_id != thread.context_id
        || objective.coordinator_session_id != thread.session_id
        || objective.initiating_principal_id != thread.initiating_principal_id
    {
        return Err("Question does not own the current Objective Evaluation".into());
    }
    Ok(())
}

pub fn question_wait(
    thread: &ThreadRecord,
    request_id: &str,
) -> crate::memory::ObjectiveWaitCondition {
    crate::memory::ObjectiveWaitCondition::UserInput {
        session_id: thread.session_id.clone(),
        request_id: Some(request_id.to_owned()),
    }
}

pub fn objective_wait_projection(
    objective: &crate::memory::ObjectiveRecord,
    question: &crate::memory::ObjectiveWaitCondition,
) -> Option<crate::memory::ObjectiveWaitCondition> {
    match objective.wait_condition.as_ref() {
        None | Some(crate::memory::ObjectiveWaitCondition::UserInput { .. }) => {
            Some(question.clone())
        }
        other => other.cloned(), // Keep unrelated physical/Group barriers.
    }
}

/// One actual tool result for the saved native call. It is persisted alongside
/// the Human input, but has no independent wake: the exact Human Signal owns
/// resumption, so this cannot accidentally start a second Evaluation.
pub fn answer_receipt(request: &Event, answer: &Event) -> Result<Event, String> {
    let activation = request
        .payload
        .get("activation_id")
        .and_then(serde_json::Value::as_str)
        .ok_or("Question is missing its native Activation")?;
    let call = request
        .payload
        .get("tool_call_id")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("Question is missing its native call")?;
    let mut payload = request.payload.clone();
    for key in [
        "questions",
        "disposition",
        "assistant_call_event_id",
        "objective_id",
        "objective_generation",
        "objective_evaluation_id",
        "objective_revision",
        "objective_evaluation_elapsed_seconds",
    ] {
        payload.remove(key);
    }
    payload.insert("attempt_id".into(), json!(activation));
    payload.insert("tool_name".into(), json!(TOOL_NAME));
    payload.insert("tool_status".into(), json!("success"));
    payload.insert("caused_by".into(), json!(call));
    payload.insert("answer_event_id".into(), json!(answer.id));
    payload.insert("wake_policy".into(), json!("none"));
    payload.insert(
        "text".into(),
        json!(json!({
            "status": "answered", "request_id": request.id, "answer_event_id": answer.id,
            "answers": answer.payload.get("user_input_answers"),
            "text": answer.payload.get("text")
        })
        .to_string()),
    );
    let mut receipt = Event::new(
        format!("output_{activation}_{call}"),
        "Runtime-UserInput".into(),
        crate::event::TYPE_TOOL_OUTPUT.into(),
        "chat/tool_output".into(),
        payload,
    );
    receipt.timestamp = answer.timestamp;
    Ok(receipt)
}

pub fn is_answer_receipt(event: &Event) -> bool {
    event.actor == "Runtime-UserInput"
        && event.topic == "chat/tool_output"
        && event.event_type == crate::event::TYPE_TOOL_OUTPUT
        && event
            .payload
            .get("tool_name")
            .and_then(serde_json::Value::as_str)
            == Some(TOOL_NAME)
        && event
            .payload
            .get("answer_event_id")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|id| !id.is_empty())
}

/// Bind the accepted structured answer to the one human-authored input. The
/// ingress transaction must still validate and consume the current dependency.
pub fn route_reply(
    event: &mut Event,
    reply: &UserInputReply,
    request_event: &Event,
    thread: &ThreadRecord,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    validate_reply_route(event, reply, thread)?;
    let request = PendingUserInputRequest::from_event(request_event)?;
    let answer = reply.answer_text(&request).map_err(|message| {
        crate::runtime::MessageIngressError::new(
            crate::runtime::MessageIngressErrorKind::InvalidArgument,
            message,
        )
    })?;
    if !request.owns_thread(thread)
        || thread.control_state != ThreadControlState::Active
        || thread.kind == ThreadKind::Delivery
        || thread.executor_kind != "self"
        || thread
            .initiating_principal_id
            .as_deref()
            .is_none_or(str::is_empty)
        || ["session_id", "context_id", "principal_id"]
            .iter()
            .any(|key| event.payload.get(*key) != request_event.payload.get(*key))
    {
        return Err(crate::steering::conflict(
            "The question is not open in this authorized execution route",
        ));
    }
    let actual = crate::session_io::event_message(event)
        .map(|message| message.summary())
        .unwrap_or_else(|| {
            event
                .payload
                .get("text")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_owned()
        });
    if actual != answer {
        return Err(Box::new(crate::runtime::MessageIngressError::new(
            crate::runtime::MessageIngressErrorKind::InvalidArgument,
            "The Human input does not match its selected answers and original free text",
        )));
    }
    // Reuse the established directed-input contract, including its frozen
    // annotation/Session IO binding. Objective ownership is restored only from
    // this saved request, never from caller-supplied Objective IDs.
    let mut routing_thread = thread.clone();
    routing_thread.supervision.supervisor_kind = crate::memory::ThreadSupervisorKind::Runtime;
    crate::steering::route(
        event,
        &crate::steering::InputDestination::Thread {
            thread_id: thread.id.clone(),
            generation: thread.generation,
        },
        &routing_thread,
        None,
    )?;
    event
        .payload
        .insert("reply_to_request_id".into(), json!(request.request_id));
    event
        .payload
        .insert("user_input_answers".into(), json!(reply.answers));
    if let (Some(objective), Some(generation), Some(_)) = (
        request_event.payload.get("objective_id"),
        request_event.payload.get("objective_generation"),
        request_event.payload.get("objective_evaluation_id"),
    ) {
        event
            .payload
            .insert("objective_interrupt".into(), json!(true));
        event
            .payload
            .insert("objective_id".into(), objective.clone());
        event
            .payload
            .insert("objective_generation".into(), generation.clone());
    }
    Ok(())
}

/// Check the recipient before looking up or exposing its question state.
pub fn validate_reply_route(
    event: &Event,
    reply: &UserInputReply,
    thread: &ThreadRecord,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if thread
        .initiating_principal_id
        .as_deref()
        .is_none_or(str::is_empty)
        || event
            .payload
            .get("principal_id")
            .and_then(serde_json::Value::as_str)
            != thread.initiating_principal_id.as_deref()
        || event
            .payload
            .get("session_id")
            .and_then(serde_json::Value::as_str)
            != Some(thread.session_id.as_str())
        || event
            .payload
            .get("context_id")
            .and_then(serde_json::Value::as_str)
            != Some(thread.context_id.as_str())
    {
        return Err(Box::new(crate::runtime::MessageIngressError::new(
            crate::runtime::MessageIngressErrorKind::Forbidden,
            "The question recipient is outside this initiating Principal/Session route",
        )));
    }
    if reply.thread_id != thread.id
        || reply.generation != thread.generation
        || thread.lifecycle.is_terminal()
        || thread.control_state != ThreadControlState::Active
        || thread.kind == ThreadKind::Delivery
        || thread.executor_kind != "self"
    {
        return Err(crate::steering::conflict(
            "The question recipient is no longer active in this execution generation",
        ));
    }
    Ok(())
}

/// Validate against locked Runtime records before inserting a wait. The model
/// cannot supply a recipient, execution route, request identity or generation.
pub fn validate_request_owner(
    event: &Event,
    thread: &ThreadRecord,
    activation: &ThreadActivationRecord,
) -> Result<PendingUserInputRequest, String> {
    let request = PendingUserInputRequest::from_event(event)?;
    let string = |key: &str| event.payload.get(key).and_then(serde_json::Value::as_str);
    if !request.owns_thread(thread)
        || thread.control_state != ThreadControlState::Active
        || thread.kind == ThreadKind::Delivery
        || thread.executor_kind != "self"
        || thread
            .initiating_principal_id
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
        || string("principal_id") != thread.initiating_principal_id.as_deref()
        || string("agent_id") != Some(thread.agent_id.as_str())
        || string("root_turn_id") != Some(thread.root_turn_id.as_str())
        || string("activation_id") != Some(activation.id.as_str())
        || event.id != request_event_id(&activation.id)
        || activation.root_turn_id != thread.root_turn_id
        || activation.agent_id != thread.agent_id
        || activation.context_id != thread.context_id
        || activation.session_id != thread.session_id
        || activation.generation != thread.generation
        || activation.status != ThreadActivationStatus::Running
        || activation.initiating_principal_id != thread.initiating_principal_id
    {
        return Err("User input request does not own this active execution route".into());
    }
    Ok(request)
}

/// A projection must prove the current pending edge, immutable body and owner
/// together. A retained old Event or an unrelated Context is not a question.
pub fn pending_request(
    thread: &ThreadRecord,
    dependency: &SchedulerDependencyRecord,
    event: &Event,
) -> Result<Option<PendingUserInputRequest>, String> {
    if dependency.owner_kind != SchedulerDependencyOwnerKind::Thread
        || dependency.owner_id != thread.id
        || dependency.owner_generation != thread.generation
        || dependency.dependency_kind != SchedulerDependencyKind::UserInput
        || dependency.status != SchedulerDependencyStatus::Pending
        || !dependency.required
        || thread.lifecycle.is_terminal()
    {
        return Ok(None);
    }
    let request = PendingUserInputRequest::from_event(event)?;
    if !request.owns_thread(thread)
        || thread
            .initiating_principal_id
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
        || dependency.dependency_id != event.id
        || dependency
            .metadata
            .get("source")
            .and_then(serde_json::Value::as_str)
            != Some(TOOL_NAME)
        || dependency
            .metadata
            .get("request_event_id")
            .and_then(serde_json::Value::as_str)
            != Some(event.id.as_str())
        || event
            .payload
            .get("principal_id")
            .and_then(serde_json::Value::as_str)
            != thread.initiating_principal_id.as_deref()
    {
        return Err("Pending user input request has an inconsistent owner or Event binding".into());
    }
    Ok(Some(request))
}

pub fn definition() -> ToolDefinition {
    ToolDefinition {
        name: TOOL_NAME.into(),
        description: "Ask the initiating user for information or a decision needed to continue this exact work. Supply one to three explicit questions in the user's language, with optional choices; free text is always accepted. This durably waits for a matching answer without polling, model retries, creating an Objective, or ending the logical task. It must be the sole call with no ordinary body. Never treat a question answer as permission approval, credentials or OS authorization; their dedicated human flows remain authoritative. Asking the user to report completion of a manual step is allowed, but verify the result instead of treating their answer as a system grant. Do not use it for status reporting or work the Runtime can continue itself. Closing the question UI is not an answer. Runtime assigns the request and execution identity.".into(),
        parameters: json!({
            "type": "object", "additionalProperties": false,
            "properties": { "questions": {
                "type": "array", "minItems": 1, "maxItems": 3,
                "items": { "type": "object", "additionalProperties": false,
                    "properties": {
                        "id": { "type": "string", "minLength": 1, "maxLength": 64, "pattern": "^[A-Za-z0-9_-]+$" },
                        "question": { "type": "string", "minLength": 1, "maxLength": 2000 },
                        "multi_select": { "type": "boolean", "description": "Default false. Enable only when several choices may be selected." },
                        "options": { "type": "array", "maxItems": 8, "items": {
                            "type": "object", "additionalProperties": false,
                            "properties": {
                                "id": { "type": "string", "minLength": 1, "maxLength": 64, "pattern": "^[A-Za-z0-9_-]+$" },
                                "label": { "type": "string", "minLength": 1, "maxLength": 200 },
                                "description": { "type": "string", "minLength": 1, "maxLength": 1000 }
                            }, "required": ["id", "label"]
                        }}
                    }, "required": ["id", "question"]
                }
            }}, "required": ["questions"]
        }),
    }
}

/// Malformed native arguments retain the normal tool-error path; never infer
/// a question from partial JSON, an annotation or ordinary response text.
pub fn classify(
    response: &Response,
    native_arguments: bool,
) -> Result<Option<RequestUserInput>, String> {
    let calls = response
        .tool_calls
        .iter()
        .filter(|call| {
            call.func_name == TOOL_NAME
                && (!native_arguments
                    || crate::session_io::native::parse_tool_arguments(&call.arguments).is_ok())
        })
        .collect::<Vec<_>>();
    if calls.is_empty() {
        return Ok(None);
    }
    if calls.len() != 1 || response.tool_calls.len() != 1 || !response.content.trim().is_empty() {
        return Err("request_user_input must be the sole call without ordinary content".into());
    }
    RequestUserInput::parse(&calls[0].arguments).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> RequestUserInput {
        RequestUserInput::parse(r#"{"questions":[{"id":"preview","question":"Enable the preview?","options":[{"id":"yes","label":"Enable"},{"id":"no","label":"Keep it off"}]}]}"#).unwrap()
    }
    fn answer(ids: &[&str], text: &str) -> UserInputAnswer {
        UserInputAnswer {
            question_id: "preview".into(),
            selected_option_ids: ids.iter().map(|id| (*id).into()).collect(),
            text: text.into(),
        }
    }
    fn ownership() -> (
        ThreadRecord,
        ThreadActivationRecord,
        Event,
        SchedulerDependencyRecord,
    ) {
        use crate::memory::{DeliveryStatus, ThreadLifecycle, ThreadSupervision};
        let now = Utc::now();
        let thread = ThreadRecord {
            response_annotations: crate::response_annotations::Protocol::Off,
            model_alias: None,
            reasoning_effort: None,
            id: "thread-original".into(),
            revision: 1,
            generation: 2,
            agent_id: "agent-original".into(),
            context_id: "context-original".into(),
            session_id: "session-original".into(),
            initiating_principal_id: Some("human-original".into()),
            root_turn_id: "root-original".into(),
            kind: ThreadKind::Execution,
            lifecycle: ThreadLifecycle::Open,
            control_state: ThreadControlState::Active,
            executor_kind: "self".into(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::objective_primary_execution("objective-original", 1),
            result_text: None,
            result_event_id: None,
            delivery_status: DeliveryStatus::None,
            delivery_event_id: None,
            created_at: now,
            updated_at: now,
        };
        let activation = ThreadActivationRecord {
            id: "activation-original".into(),
            revision: 1,
            generation: thread.generation,
            agent_id: thread.agent_id.clone(),
            context_id: thread.context_id.clone(),
            session_id: thread.session_id.clone(),
            initiating_principal_id: thread.initiating_principal_id.clone(),
            trigger_event_id: thread.root_turn_id.clone(),
            trigger_sequence: 1,
            trigger_kind: "chat/user_message".into(),
            parent_activation_id: None,
            root_turn_id: thread.root_turn_id.clone(),
            context_snapshot_version: None,
            model_alias: None,
            reasoning_effort: None,
            status: ThreadActivationStatus::Running,
            claimed_by: Some("runtime-test".into()),
            lease_expires_at: None,
            dialogue_lane_released_at: None,
            created_at: now,
            updated_at: now,
        };
        let payload = json!({
            "disposition": DISPOSITION, "agent_id": thread.agent_id,
            "context_id": thread.context_id, "session_id": thread.session_id,
            "principal_id": thread.initiating_principal_id, "root_turn_id": thread.root_turn_id,
            "thread_id": thread.id, "thread_generation": thread.generation,
            "activation_id": activation.id, "questions": request().questions,
        });
        let event = Event::new(
            request_event_id(&activation.id),
            "Agent-Morphz".into(),
            crate::event::TYPE_AGENT_CALL.into(),
            REQUEST_TOPIC.into(),
            payload
                .as_object()
                .unwrap()
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        );
        let dependency = SchedulerDependencyRecord {
            id: "dependency-original".into(),
            owner_kind: SchedulerDependencyOwnerKind::Thread,
            owner_id: thread.id.clone(),
            owner_generation: thread.generation,
            dependency_kind: SchedulerDependencyKind::UserInput,
            dependency_id: event.id.clone(),
            dependency_generation: 1,
            required: true,
            status: SchedulerDependencyStatus::Pending,
            metadata: json!({"source": TOOL_NAME, "request_event_id": event.id}),
            satisfied_by_event_id: None,
            created_at: now,
            updated_at: now,
            satisfied_at: None,
        };
        (thread, activation, event, dependency)
    }

    #[test]
    fn user_input_request_owner_is_the_exact_live_runtime_route() {
        let (thread, activation, event, _) = ownership();
        assert!(validate_request_owner(&event, &thread, &activation).is_ok());
        for key in [
            "agent_id",
            "context_id",
            "session_id",
            "principal_id",
            "root_turn_id",
            "thread_id",
            "activation_id",
        ] {
            let mut forged = event.clone();
            forged.payload.insert(key.into(), json!("unrelated"));
            assert!(
                validate_request_owner(&forged, &thread, &activation).is_err(),
                "{key}"
            );
        }
        let mut stale = event.clone();
        stale.payload.insert("thread_generation".into(), json!(1));
        assert!(validate_request_owner(&stale, &thread, &activation).is_err());
        let mut other_id = event.clone();
        other_id.id = "model-selected-request".into();
        assert!(validate_request_owner(&other_id, &thread, &activation).is_err());
        let mut paused = thread.clone();
        paused.control_state = ThreadControlState::Paused;
        assert!(validate_request_owner(&event, &paused, &activation).is_err());
        let mut completed = activation.clone();
        completed.status = ThreadActivationStatus::Succeeded;
        assert!(validate_request_owner(&event, &thread, &completed).is_err());
    }

    #[test]
    fn user_input_projection_requires_a_current_pending_dependency() {
        let (thread, _, event, dependency) = ownership();
        let expected = PendingUserInputRequest::from_event(&event).unwrap();
        assert_eq!(
            pending_request(&thread, &dependency, &event).unwrap(),
            Some(expected)
        );
        for status in [
            SchedulerDependencyStatus::Satisfied,
            SchedulerDependencyStatus::Cancelled,
        ] {
            let mut settled = dependency.clone();
            settled.status = status;
            assert!(pending_request(&thread, &settled, &event)
                .unwrap()
                .is_none());
        }
        let mut stale = dependency.clone();
        stale.owner_generation += 1;
        assert!(pending_request(&thread, &stale, &event).unwrap().is_none());
        let mut forged = dependency.clone();
        forged.metadata["request_event_id"] = json!("a-different-body");
        assert!(pending_request(&thread, &forged, &event).is_err());
        let mut paused = thread.clone();
        paused.control_state = ThreadControlState::Paused;
        assert!(pending_request(&paused, &dependency, &event)
            .unwrap()
            .is_some());
    }

    #[test]
    fn user_input_control_is_exclusive_and_plain_text_is_inert() {
        let response = Response {
            content: String::new(),
            tool_calls: vec![crate::llm::ToolCallRepr {
                id: "call-question".into(),
                r#type: "function".into(),
                func_name: TOOL_NAME.into(),
                arguments: serde_json::to_string(&request()).unwrap(),
            }],
        };
        assert_eq!(classify(&response, true).unwrap(), Some(request()));
        let mut mixed = response.clone();
        mixed.content = "Also a final answer".into();
        assert!(classify(&mixed, true).is_err());
        mixed.content.clear();
        mixed.tool_calls.push(response.tool_calls[0].clone());
        assert!(classify(&mixed, true).is_err());
        let text = Response {
            content: format!("Example: {TOOL_NAME}({{questions: []}})"),
            tool_calls: Vec::new(),
        };
        assert!(classify(&text, true).unwrap().is_none());
        let mut malformed = response;
        malformed.tool_calls[0].arguments = "{truncated".into();
        assert!(classify(&malformed, true).unwrap().is_none());
        assert!(classify(&malformed, false).is_err());
    }

    #[test]
    fn user_input_answers_do_not_retarget_another_pending_question() {
        let (_, _, event, _) = ownership();
        let request = PendingUserInputRequest::from_event(&event).unwrap();
        let reply = UserInputReply {
            request_id: request.request_id.clone(),
            thread_id: request.thread_id.clone(),
            generation: request.thread_generation,
            answers: vec![answer(&["yes"], "Only locally")],
        };
        assert_eq!(reply.answer_text(&request).unwrap(), "Enable\nOnly locally");
        let mut changed = reply.clone();
        changed.request_id = "other-question".into();
        assert!(changed.answer_text(&request).is_err());
        changed = reply.clone();
        changed.thread_id = "other-thread".into();
        assert!(changed.answer_text(&request).is_err());
        changed = reply;
        changed.generation += 1;
        assert!(changed.answer_text(&request).is_err());
    }
    #[test]
    fn user_input_requires_explicit_bounded_unique_questions() {
        for value in [
            r#"{"questions":[]}"#,
            r#"{"questions":[{"id":"a","question":" "}]}"#,
            r#"{"questions":[{"id":"a","question":"A"},{"id":"a","question":"B"}]}"#,
            r#"{"questions":[{"id":"a","question":"A","options":[{"id":"x","label":"X"},{"id":"x","label":"Y"}]}]}"#,
            r#"{"questions":[{"id":"a","question":"A","multi_select":true}]}"#,
            r#"{"questions":[{"id":"a","question":"A"}],"thread_id":"forged"}"#,
        ] {
            assert!(RequestUserInput::parse(value).is_err(), "{value}");
        }
        let mut huge = request();
        huge.questions[0].question = "a".repeat(2001);
        assert!(huge.validate().is_err());
        assert!(RequestUserInput::parse(&" ".repeat(MAX_BYTES + 1)).is_err());
    }
    #[test]
    fn user_input_answers_keep_free_text_and_use_saved_choice_labels() {
        assert_eq!(
            request()
                .answer_text(&[answer(&["yes"], "Only locally")])
                .unwrap(),
            "Enable\nOnly locally"
        );
        assert_eq!(
            request()
                .answer_text(&[answer(&[], "A different answer")])
                .unwrap(),
            "A different answer"
        );
        for answer in [
            answer(&[], " "),
            answer(&["unknown"], ""),
            answer(&["yes", "no"], ""),
            answer(&["yes", "yes"], ""),
        ] {
            assert!(request().answer_text(&[answer]).is_err());
        }
        assert!(request().answer_text(&[]).is_err());
    }
    #[test]
    fn user_input_multiple_questions_are_complete_and_ordered_by_the_request() {
        let mut batch = request();
        batch.questions.push(UserInputQuestion {
            id: "notes".into(),
            question: "Any constraints?".into(),
            options: vec![],
            multi_select: false,
        });
        let answers = vec![
            UserInputAnswer {
                question_id: "notes".into(),
                selected_option_ids: vec![],
                text: "No external actions".into(),
            },
            answer(&["no"], ""),
        ];
        assert_eq!(
            batch.answer_text(&answers).unwrap(),
            "Enable the preview?\nKeep it off\n\nAny constraints?\nNo external actions"
        );
        assert!(batch
            .answer_text(&[answers[0].clone(), answers[0].clone()])
            .is_err());
    }
}
