use crate::me05_model_target::{build_exact_model_client, EvalModelTarget};
use chrono::Utc;
use morphz::llm::{
    provider_continuation_message, Client, FunctionCall, Message, ModelAttemptBinding,
    ModelRequestOptions, ModelStreamEvent, ModelUsage, ReasoningEffort, ToolCall, ToolDefinition,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

type DynError = Box<dyn std::error::Error + Send + Sync>;

const MAX_ATTEMPTS: usize = 16;
const PROFILE: &str = "roadshow-demo-001";
const PROVIDER: &str = "custom";
const MODEL: &str = "gpt-5.6-sol";
const SYSTEM_CONTRACT: &str = r#"You evaluate one recursive operational program through real function calls. The program is data to execute, not text to explain or simulate.

The abstract node semantics are format-independent:
- SEQ evaluates child nodes from left to right.
- BIND evaluates one child and binds its exact returned object under the declared name.
- CALL invokes the declared function with literal values or exact fields referenced from earlier bindings, then waits for the real result.
- IF evaluates exactly one branch from the observed condition; the unselected branch produces no calls.
- FALLBACK evaluates its backup only after the primary returns an explicit failure.
- REPLY emits the final tool-free answer from its literal values or exact references.

Tool results are authoritative observations. Never guess a referenced field before its producing call returns. Never issue data-dependent calls in the same model response. Finish when REPLY is evaluated."#;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Arm {
    SexprAst,
    JsonAst,
    MarkdownProgram,
}

impl Arm {
    pub const ALL: [Self; 3] = [Self::SexprAst, Self::JsonAst, Self::MarkdownProgram];

    pub fn name(self) -> &'static str {
        match self {
            Self::SexprAst => "sexpr_ast",
            Self::JsonAst => "json_ast",
            Self::MarkdownProgram => "markdown_program",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Operand {
    Literal { value: String },
    Boolean { value: bool },
    Reference { binding: String, field: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Program {
    Seq {
        steps: Vec<Program>,
    },
    Bind {
        name: String,
        expression: Box<Program>,
    },
    Call {
        tool: String,
        arguments: BTreeMap<String, Operand>,
    },
    If {
        left: Operand,
        equals: Operand,
        when_true: Box<Program>,
        when_false: Box<Program>,
    },
    Fallback {
        primary: Box<Program>,
        backup: Box<Program>,
    },
    Reply {
        values: Vec<Operand>,
    },
}

#[derive(Clone)]
struct EvalTask {
    id: &'static str,
    program: Program,
    expected_tools: Vec<String>,
    dependencies: Vec<(String, String)>,
    forbidden_tools: Vec<String>,
    final_tokens: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolTrace {
    pub attempt: usize,
    pub name: String,
    pub arguments: Value,
    pub output: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CriterionResult {
    pub id: String,
    pub passed: bool,
    pub evidence: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestArtifact {
    pub attempt: usize,
    pub prompt_measurement: Option<morphz::llm::PromptTokenCount>,
    pub messages: Vec<Message>,
    pub response: Option<morphz::llm::Response>,
    pub stream_events: Vec<ModelStreamEvent>,
    pub usage: ModelUsage,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpisodeReport {
    pub repetition: usize,
    pub arm: String,
    pub task: String,
    pub semantic_digest: String,
    pub success: bool,
    pub semantic_success: bool,
    pub score: u32,
    pub max_score: u32,
    pub attempts: usize,
    pub prompt_chars: usize,
    pub tool_trace: Vec<ToolTrace>,
    pub final_answer: String,
    pub error: Option<String>,
    pub criteria: Vec<CriterionResult>,
    pub requests: Vec<RequestArtifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArmSummary {
    pub episodes: usize,
    pub passed: usize,
    pub pass_rate: f64,
    pub semantic_passed: usize,
    pub semantic_pass_rate: f64,
    pub mean_attempts: f64,
    pub mean_tool_calls: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepresentationEvalReport {
    pub id: String,
    pub created_at: String,
    pub model: String,
    pub provider: String,
    pub protocol: String,
    pub immutable_binding: ModelAttemptBinding,
    pub reasoning_effort: String,
    pub repetitions: usize,
    pub output_dir: PathBuf,
    pub summaries: BTreeMap<String, ArmSummary>,
    pub episodes: Vec<EpisodeReport>,
    pub conclusion_boundary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptArmArtifact {
    pub arm: String,
    pub semantic_digest: String,
    pub system_contract_sha256: String,
    pub prompt_chars: usize,
    pub prompt_bytes: usize,
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptTaskArtifact {
    pub task: String,
    pub canonical_program: Value,
    pub semantic_digest: String,
    pub arms: Vec<PromptArmArtifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoModelGateReport {
    pub id: String,
    pub created_at: String,
    pub output_dir: PathBuf,
    pub tasks: usize,
    pub arms_per_task: usize,
    pub semantic_digest_gate: bool,
    pub common_system_contract_gate: bool,
    pub hidden_output_leakage_gate: bool,
    pub typed_literal_gate: bool,
    pub scorer_positive_gate: bool,
    pub scorer_negative_gate: bool,
    pub ready_for_real_pilot: bool,
    pub prompt_bundle: Vec<PromptTaskArtifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BindingPreflightReport {
    pub id: String,
    pub created_at: String,
    pub profile: String,
    pub requested_reasoning_effort: String,
    pub binding: ModelAttemptBinding,
    pub completion_calls: usize,
    pub passed: bool,
}

pub fn run_no_model_gate(output_base: &Path) -> Result<NoModelGateReport, DynError> {
    let id = format!(
        "ME-02-no-model-p1.1-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    );
    let output_dir = output_base.join(&id);
    std::fs::create_dir_all(&output_dir)?;

    let tasks = tasks();
    let prompt_bundle = prompt_bundle(&tasks)?;
    let semantic_digest_gate = prompt_bundle.iter().all(|task| {
        task.arms
            .iter()
            .all(|arm| arm.semantic_digest == task.semantic_digest)
    });
    let system_hash = sha256_hex(SYSTEM_CONTRACT.as_bytes());
    let common_system_contract_gate = prompt_bundle.iter().all(|task| {
        task.arms
            .iter()
            .all(|arm| arm.system_contract_sha256 == system_hash)
    });
    let hidden_output_leakage_gate = prompt_bundle.iter().all(|task| {
        task.arms.iter().all(|arm| {
            hidden_tool_outputs()
                .iter()
                .all(|hidden| !arm.prompt.contains(hidden))
        })
    });
    let typed_literal_gate = typed_literal_gate(&prompt_bundle);
    let scorer_positive_gate = tasks.iter().all(scorer_accepts_registered_positive);
    let scorer_negative_gate = tasks.iter().all(scorer_rejects_registered_negatives);
    let ready_for_real_pilot = semantic_digest_gate
        && common_system_contract_gate
        && hidden_output_leakage_gate
        && typed_literal_gate
        && scorer_positive_gate
        && scorer_negative_gate;

    std::fs::write(
        output_dir.join("prompt_bundle.json"),
        serde_json::to_vec_pretty(&prompt_bundle)?,
    )?;
    let report = NoModelGateReport {
        id,
        created_at: Utc::now().to_rfc3339(),
        output_dir: output_dir.clone(),
        tasks: tasks.len(),
        arms_per_task: Arm::ALL.len(),
        semantic_digest_gate,
        common_system_contract_gate,
        hidden_output_leakage_gate,
        typed_literal_gate,
        scorer_positive_gate,
        scorer_negative_gate,
        ready_for_real_pilot,
        prompt_bundle,
    };
    std::fs::write(
        output_dir.join("gate_report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(report)
}

pub async fn run_binding_preflight(output_base: &Path) -> Result<BindingPreflightReport, DynError> {
    let id = format!(
        "ME-02-binding-preflight-p1.1-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    );
    let output_dir = output_base.join(&id);
    std::fs::create_dir_all(&output_dir)?;
    let target = eval_model_target()?;
    let (_client, _runtime_guard, binding) = exact_model_client(&output_dir, &target).await?;
    let report = BindingPreflightReport {
        id,
        created_at: Utc::now().to_rfc3339(),
        profile: target.profile.clone().unwrap_or_else(|| "none".to_string()),
        requested_reasoning_effort: target.reasoning_effort.as_str().to_string(),
        binding,
        completion_calls: 0,
        passed: true,
    };
    std::fs::write(
        output_dir.join("binding_preflight.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(report)
}

pub async fn run_real_pilot(
    output_base: &Path,
    repetitions: usize,
) -> Result<RepresentationEvalReport, DynError> {
    if repetitions == 0 {
        return Err("repetitions must be greater than zero".into());
    }
    let id = format!(
        "ME-02-pilot-p1.1-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    );
    let output_dir = output_base.join(&id);
    std::fs::create_dir_all(&output_dir)?;
    let target = eval_model_target()?;
    let (client, _runtime_guard, binding) = exact_model_client(&output_dir, &target).await?;
    let task_set = selected_tasks()?;
    let arms = selected_arms()?;
    std::fs::write(
        output_dir.join("prompt_bundle.json"),
        serde_json::to_vec_pretty(&prompt_bundle_for_arms(&task_set, &arms)?)?,
    )?;

    let mut episodes = Vec::new();
    for repetition in 1..=repetitions {
        for (task_index, task) in task_set.iter().enumerate() {
            let rotation = (task_index + repetition - 1) % arms.len();
            for offset in 0..arms.len() {
                let arm = arms[(rotation + offset) % arms.len()];
                let episode = run_episode(
                    client.as_ref(),
                    &binding,
                    target.reasoning_effort,
                    repetition,
                    arm,
                    task,
                )
                .await?;
                std::fs::write(
                    output_dir.join(format!(
                        "episode-{:02}-{}-{}.json",
                        repetition,
                        task.id,
                        arm.name()
                    )),
                    serde_json::to_vec_pretty(&episode)?,
                )?;
                episodes.push(episode);
            }
        }
    }

    let report = RepresentationEvalReport {
        id,
        created_at: Utc::now().to_rfc3339(),
        model: binding.physical_model.clone(),
        provider: binding.provider_instance_id.clone(),
        protocol: binding.protocol.clone(),
        immutable_binding: binding,
        reasoning_effort: format!(
            "requested={0}; client={0}; per-request-options={0}",
            target.reasoning_effort.as_str()
        ),
        repetitions,
        output_dir: output_dir.clone(),
        summaries: summarize(&episodes),
        episodes,
        conclusion_boundary: "ME-02 p1 changes only the serialization of one canonical recursive program. A Pilot result can diagnose feasibility, ceiling/floor effects and format bias; it is not a confirmatory claim that S-expression is superior, nor evidence about Context transactions, long-term memory, concurrency or public benchmark performance.".to_string(),
    };
    std::fs::write(
        output_dir.join("report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(report)
}

async fn run_episode(
    client: &dyn Client,
    binding: &ModelAttemptBinding,
    reasoning_effort: ReasoningEffort,
    repetition: usize,
    arm: Arm,
    task: &EvalTask,
) -> Result<EpisodeReport, DynError> {
    let task_prompt = render_program(&task.program, arm)?;
    let semantic_digest = semantic_digest(&task.program)?;
    let mut messages = vec![
        message("system", SYSTEM_CONTRACT),
        message("user", &task_prompt),
    ];
    let definitions = tool_definitions();
    let mut trace = Vec::new();
    let mut final_answer = String::new();
    let mut episode_error = None;
    let mut attempts = 0usize;
    let mut requests = Vec::new();

    for attempt in 1..=MAX_ATTEMPTS {
        attempts = attempt;
        let measurement = client
            .count_prompt_tokens(
                &format!("ME-02/{}/{}/{}", task.id, arm.name(), attempt),
                &messages,
                &definitions,
            )
            .await?;
        let request_messages = messages.clone();
        let (stream_sender, mut stream_receiver) = tokio::sync::mpsc::unbounded_channel();
        let completion = client
            .create_completion_bound_stream_with_options(
                binding,
                request_messages.clone(),
                definitions.clone(),
                measurement.clone(),
                stream_sender,
                ModelRequestOptions {
                    reasoning_effort: Some(Some(reasoning_effort)),
                },
            )
            .await;
        let mut stream_events = Vec::new();
        let mut usage = ModelUsage::default();
        while let Ok(event) = stream_receiver.try_recv() {
            if let ModelStreamEvent::Usage { usage: observed } = &event {
                usage.merge_from(observed);
            }
            stream_events.push(event);
        }

        let (response, provider_continuation) = match completion {
            Ok(response) => {
                let provider_continuation = stream_events.iter().rev().find_map(|event| {
                    if let ModelStreamEvent::ProviderContinuation { continuation } = event {
                        Some(continuation.clone())
                    } else {
                        None
                    }
                });
                requests.push(RequestArtifact {
                    attempt,
                    prompt_measurement: measurement,
                    messages: request_messages,
                    response: Some(response.clone()),
                    stream_events,
                    usage,
                    error: None,
                });
                (response, provider_continuation)
            }
            Err(error) => {
                let message = error.to_string();
                requests.push(RequestArtifact {
                    attempt,
                    prompt_measurement: measurement,
                    messages: request_messages,
                    response: None,
                    stream_events,
                    usage,
                    error: Some(message.clone()),
                });
                episode_error = Some(message);
                break;
            }
        };

        if response.tool_calls.is_empty() {
            final_answer = response.content;
            break;
        }
        let calls = response
            .tool_calls
            .iter()
            .map(|call| ToolCall {
                id: call.id.clone(),
                r#type: call.r#type.clone(),
                function: FunctionCall {
                    name: call.func_name.clone(),
                    arguments: call.arguments.clone(),
                },
            })
            .collect::<Vec<_>>();
        if let Some(continuation) = provider_continuation {
            messages.push(provider_continuation_message(continuation)?);
        }
        messages.push(Message {
            role: "assistant".to_string(),
            content: response.content,
            name: None,
            tool_call_id: None,
            tool_calls: Some(calls),
        });
        for call in response.tool_calls {
            let arguments = serde_json::from_str::<Value>(&call.arguments)
                .unwrap_or_else(|_| json!({"_invalid_json":call.arguments}));
            let output = execute_tool(&call.func_name, &arguments);
            trace.push(ToolTrace {
                attempt,
                name: call.func_name.clone(),
                arguments,
                output: output.clone(),
            });
            messages.push(Message {
                role: "tool".to_string(),
                content: output.to_string(),
                name: Some(call.func_name),
                tool_call_id: Some(call.id),
                tool_calls: None,
            });
        }
    }

    let criteria = score_episode(task, &trace, &final_answer);
    let score = criteria.iter().filter(|criterion| criterion.passed).count() as u32;
    let max_score = criteria.len() as u32;
    let semantic_success = criteria
        .iter()
        .filter(|criterion| criterion.id != "exact-tool-plan")
        .all(|criterion| criterion.passed);
    Ok(EpisodeReport {
        repetition,
        arm: arm.name().to_string(),
        task: task.id.to_string(),
        semantic_digest,
        success: score == max_score,
        semantic_success,
        score,
        max_score,
        attempts,
        prompt_chars: task_prompt.chars().count(),
        tool_trace: trace,
        final_answer,
        error: episode_error,
        criteria,
        requests,
    })
}

fn eval_model_target() -> Result<EvalModelTarget, DynError> {
    EvalModelTarget::from_environment(PROFILE, PROVIDER, MODEL)
}

async fn exact_model_client(
    run_root: &Path,
    target: &EvalModelTarget,
) -> Result<
    (
        Arc<dyn Client>,
        morphz::runtime::MorphzRuntime,
        ModelAttemptBinding,
    ),
    DynError,
> {
    build_exact_model_client(run_root, target, "me02-provider-preflight", 4_096).await
}

fn prompt_bundle(tasks: &[EvalTask]) -> Result<Vec<PromptTaskArtifact>, DynError> {
    prompt_bundle_for_arms(tasks, &Arm::ALL)
}

fn prompt_bundle_for_arms(
    tasks: &[EvalTask],
    arms: &[Arm],
) -> Result<Vec<PromptTaskArtifact>, DynError> {
    tasks
        .iter()
        .map(|task| {
            let canonical = serde_json::to_value(&task.program)?;
            let digest = semantic_digest(&task.program)?;
            let arms = arms
                .iter()
                .map(|arm| {
                    let prompt = render_program(&task.program, *arm)?;
                    Ok(PromptArmArtifact {
                        arm: arm.name().to_string(),
                        semantic_digest: digest.clone(),
                        system_contract_sha256: sha256_hex(SYSTEM_CONTRACT.as_bytes()),
                        prompt_chars: prompt.chars().count(),
                        prompt_bytes: prompt.len(),
                        prompt,
                    })
                })
                .collect::<Result<Vec<_>, DynError>>()?;
            Ok(PromptTaskArtifact {
                task: task.id.to_string(),
                canonical_program: canonical,
                semantic_digest: digest,
                arms,
            })
        })
        .collect()
}

fn selected_tasks() -> Result<Vec<EvalTask>, DynError> {
    let all = tasks();
    let Ok(raw) = std::env::var("MORPHZ_ME02_TASKS") else {
        return Ok(all);
    };
    let requested = raw
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if requested.is_empty() {
        return Err("MORPHZ_ME02_TASKS selected no tasks".into());
    }
    for id in &requested {
        if !all.iter().any(|task| task.id == *id) {
            return Err(format!("unknown ME-02 task: {id}").into());
        }
    }
    Ok(all
        .into_iter()
        .filter(|task| requested.contains(&task.id))
        .collect())
}

fn selected_arms() -> Result<Vec<Arm>, DynError> {
    let Ok(raw) = std::env::var("MORPHZ_ME02_ARMS") else {
        return Ok(Arm::ALL.to_vec());
    };
    let mut arms = Vec::new();
    for name in raw
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let arm = Arm::ALL
            .into_iter()
            .find(|arm| arm.name() == name)
            .ok_or_else(|| format!("unknown ME-02 arm: {name}"))?;
        if !arms.contains(&arm) {
            arms.push(arm);
        }
    }
    if arms.is_empty() {
        return Err("MORPHZ_ME02_ARMS selected no arms".into());
    }
    Ok(arms)
}

fn semantic_digest(program: &Program) -> Result<String, DynError> {
    Ok(sha256_hex(&serde_json::to_vec(program)?))
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn render_program(program: &Program, arm: Arm) -> Result<String, DynError> {
    match arm {
        Arm::SexprAst => Ok(render_sexpr(program)),
        Arm::JsonAst => Ok(serde_json::to_string_pretty(program)?),
        Arm::MarkdownProgram => Ok(render_markdown(program, 0)),
    }
}

fn render_sexpr(program: &Program) -> String {
    match program {
        Program::Seq { steps } => format!(
            "(seq{})",
            steps
                .iter()
                .map(|step| format!("\n  {}", indent_multiline(&render_sexpr(step), 2)))
                .collect::<String>()
        ),
        Program::Bind { name, expression } => {
            format!("(bind {} {})", atom(name), render_sexpr(expression))
        }
        Program::Call { tool, arguments } => format!(
            "(call {}{})",
            atom(tool),
            arguments
                .iter()
                .map(|(name, value)| format!(" (arg {} {})", atom(name), render_operand(value)))
                .collect::<String>()
        ),
        Program::If {
            left,
            equals,
            when_true,
            when_false,
        } => format!(
            "(if (= {} {}) {} {})",
            render_operand(left),
            render_operand(equals),
            render_sexpr(when_true),
            render_sexpr(when_false)
        ),
        Program::Fallback { primary, backup } => format!(
            "(fallback {} {})",
            render_sexpr(primary),
            render_sexpr(backup)
        ),
        Program::Reply { values } => format!(
            "(reply{})",
            values
                .iter()
                .map(|value| format!(" {}", render_operand(value)))
                .collect::<String>()
        ),
    }
}

fn render_operand(operand: &Operand) -> String {
    match operand {
        Operand::Literal { value } => format!("(literal {})", atom(value)),
        Operand::Boolean { value } => format!("(boolean {value})"),
        Operand::Reference { binding, field } => {
            format!("(ref {} {})", atom(binding), atom(field))
        }
    }
}

fn render_markdown(program: &Program, depth: usize) -> String {
    let pad = "  ".repeat(depth);
    match program {
        Program::Seq { steps } => {
            let mut output = format!("{pad}- SEQ\n");
            for (index, step) in steps.iter().enumerate() {
                output.push_str(&format!("{pad}  - STEP {}\n", index + 1));
                output.push_str(&render_markdown(step, depth + 2));
            }
            output
        }
        Program::Bind { name, expression } => format!(
            "{pad}- BIND `{name}` TO\n{}",
            render_markdown(expression, depth + 1)
        ),
        Program::Call { tool, arguments } => {
            let mut output = format!("{pad}- CALL `{tool}`\n");
            for (name, value) in arguments {
                output.push_str(&format!(
                    "{pad}  - ARG `{name}` = {}\n",
                    markdown_operand(value)
                ));
            }
            output
        }
        Program::If {
            left,
            equals,
            when_true,
            when_false,
        } => format!(
            "{pad}- IF {} EQUALS {}\n{pad}  - WHEN TRUE\n{}{pad}  - WHEN FALSE\n{}",
            markdown_operand(left),
            markdown_operand(equals),
            render_markdown(when_true, depth + 2),
            render_markdown(when_false, depth + 2)
        ),
        Program::Fallback { primary, backup } => format!(
            "{pad}- FALLBACK\n{pad}  - PRIMARY\n{}{pad}  - BACKUP AFTER EXPLICIT FAILURE\n{}",
            render_markdown(primary, depth + 2),
            render_markdown(backup, depth + 2)
        ),
        Program::Reply { values } => format!(
            "{pad}- REPLY WITH {}\n",
            values
                .iter()
                .map(markdown_operand)
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

fn markdown_operand(operand: &Operand) -> String {
    match operand {
        Operand::Literal { value } => format!("LITERAL `{value}`"),
        Operand::Boolean { value } => format!("BOOLEAN `{value}`"),
        Operand::Reference { binding, field } => format!("REFERENCE `{binding}.{field}`"),
    }
}

fn indent_multiline(value: &str, spaces: usize) -> String {
    let indentation = " ".repeat(spaces);
    value.replace('\n', &format!("\n{indentation}"))
}

fn atom(value: &str) -> String {
    if value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "_-./".contains(character))
    {
        value.to_string()
    } else {
        serde_json::to_string(value).expect("serializing a string cannot fail")
    }
}

fn tasks() -> Vec<EvalTask> {
    vec![
        binding_chain_task(),
        alternating_branches_task(),
        nested_fallback_task(),
        shared_reference_task(),
        merge_after_observations_task(),
        guard_no_action_task(),
    ]
}

fn binding_chain_task() -> EvalTask {
    EvalTask {
        id: "binding_chain",
        program: seq(vec![
            bind("value_a", call("make_value", [("name", lit("A"))])),
            bind(
                "value_b",
                call(
                    "make_value",
                    [
                        ("name", lit("B")),
                        ("parent", reference("value_a", "token")),
                    ],
                ),
            ),
            bind(
                "value_c",
                call(
                    "make_value",
                    [
                        ("name", lit("C")),
                        ("parent", reference("value_b", "token")),
                    ],
                ),
            ),
            bind(
                "value_d",
                call(
                    "make_value",
                    [
                        ("name", lit("D")),
                        ("parent", reference("value_c", "token")),
                    ],
                ),
            ),
            bind(
                "verified",
                call(
                    "verify_chain",
                    [
                        ("first", reference("value_a", "token")),
                        ("middle", reference("value_c", "token")),
                        ("last", reference("value_d", "token")),
                    ],
                ),
            ),
            reply([reference("verified", "delivery_token")]),
        ]),
        expected_tools: strings(&[
            "make_value:A:",
            "make_value:B:T-A-7319",
            "make_value:C:T-B-1847",
            "make_value:D:T-C-9026",
            "verify_chain:T-A-7319:T-C-9026:T-D-4651",
        ]),
        dependencies: pairs(&[
            ("make_value:A:", "make_value:B:T-A-7319"),
            ("make_value:B:T-A-7319", "make_value:C:T-B-1847"),
            ("make_value:C:T-B-1847", "make_value:D:T-C-9026"),
            (
                "make_value:D:T-C-9026",
                "verify_chain:T-A-7319:T-C-9026:T-D-4651",
            ),
        ]),
        forbidden_tools: Vec::new(),
        final_tokens: strings(&["CHAIN-VERIFIED-6194"]),
    }
}

fn alternating_branches_task() -> EvalTask {
    let mut steps = Vec::new();
    for case in ["C1", "C2", "C3", "C4"] {
        let observed = format!("observed_{}", case.to_ascii_lowercase());
        let routed = format!("routed_{}", case.to_ascii_lowercase());
        steps.push(bind(&observed, call("read_case", [("case", lit(case))])));
        steps.push(bind(
            &routed,
            Program::If {
                left: reference(&observed, "enabled"),
                equals: boolean(true),
                when_true: Box::new(call(
                    "route_true",
                    [
                        ("case", lit(case)),
                        ("token", reference(&observed, "token")),
                    ],
                )),
                when_false: Box::new(call(
                    "route_false",
                    [
                        ("case", lit(case)),
                        ("token", reference(&observed, "token")),
                    ],
                )),
            },
        ));
    }
    steps.push(bind(
        "verified",
        call(
            "verify_routes",
            [
                ("one", reference("routed_c1", "receipt")),
                ("two", reference("routed_c2", "receipt")),
                ("three", reference("routed_c3", "receipt")),
                ("four", reference("routed_c4", "receipt")),
            ],
        ),
    ));
    steps.push(reply([reference("verified", "delivery_token")]));
    EvalTask {
        id: "alternating_branches",
        program: seq(steps),
        expected_tools: strings(&[
            "read_case:C1",
            "route_true:C1:Q-C1-8264",
            "read_case:C2",
            "route_false:C2:Q-C2-2684",
            "read_case:C3",
            "route_true:C3:Q-C3-8426",
            "read_case:C4",
            "route_false:C4:Q-C4-2846",
            "verify_routes:RT-C1:RF-C2:RT-C3:RF-C4",
        ]),
        dependencies: pairs(&[
            ("read_case:C1", "route_true:C1:Q-C1-8264"),
            ("read_case:C2", "route_false:C2:Q-C2-2684"),
            ("read_case:C3", "route_true:C3:Q-C3-8426"),
            ("read_case:C4", "route_false:C4:Q-C4-2846"),
        ]),
        forbidden_tools: Vec::new(),
        final_tokens: strings(&["ROUTES-VERIFIED-2609"]),
    }
}

fn nested_fallback_task() -> EvalTask {
    EvalTask {
        id: "nested_fallback",
        program: seq(vec![
            bind(
                "selected",
                Program::Fallback {
                    primary: Box::new(call("probe_endpoint", [("name", lit("primary"))])),
                    backup: Box::new(Program::Fallback {
                        primary: Box::new(call("probe_endpoint", [("name", lit("secondary"))])),
                        backup: Box::new(call("probe_endpoint", [("name", lit("tertiary"))])),
                    }),
                },
            ),
            bind(
                "verified",
                call(
                    "verify_endpoint",
                    [
                        ("name", reference("selected", "name")),
                        ("token", reference("selected", "token")),
                    ],
                ),
            ),
            reply([reference("verified", "delivery_token")]),
        ]),
        expected_tools: strings(&[
            "probe_endpoint:primary",
            "probe_endpoint:secondary",
            "probe_endpoint:tertiary",
            "verify_endpoint:tertiary:EP-T-5541",
        ]),
        dependencies: pairs(&[
            ("probe_endpoint:primary", "probe_endpoint:secondary"),
            ("probe_endpoint:secondary", "probe_endpoint:tertiary"),
            (
                "probe_endpoint:tertiary",
                "verify_endpoint:tertiary:EP-T-5541",
            ),
        ]),
        forbidden_tools: Vec::new(),
        final_tokens: strings(&["ENDPOINT-VERIFIED-7752"]),
    }
}

fn shared_reference_task() -> EvalTask {
    EvalTask {
        id: "shared_reference",
        program: seq(vec![
            bind("source", call("fetch_piece", [("key", lit("shared"))])),
            bind(
                "left",
                call(
                    "transform_piece",
                    [
                        ("lane", lit("left")),
                        ("token", reference("source", "token")),
                    ],
                ),
            ),
            bind(
                "right",
                call(
                    "transform_piece",
                    [
                        ("lane", lit("right")),
                        ("token", reference("source", "token")),
                    ],
                ),
            ),
            bind(
                "verified",
                call(
                    "verify_shared",
                    [
                        ("left", reference("left", "receipt")),
                        ("right", reference("right", "receipt")),
                    ],
                ),
            ),
            reply([reference("verified", "delivery_token")]),
        ]),
        expected_tools: strings(&[
            "fetch_piece:shared",
            "transform_piece:left:SH-8813",
            "transform_piece:right:SH-8813",
            "verify_shared:L-8813:R-8813",
        ]),
        dependencies: pairs(&[
            ("fetch_piece:shared", "transform_piece:left:SH-8813"),
            ("fetch_piece:shared", "transform_piece:right:SH-8813"),
        ]),
        forbidden_tools: Vec::new(),
        final_tokens: strings(&["SHARED-VERIFIED-3490"]),
    }
}

fn merge_after_observations_task() -> EvalTask {
    EvalTask {
        id: "merge_after_observations",
        program: seq(vec![
            bind("alpha", call("fetch_record", [("name", lit("alpha"))])),
            bind("beta", call("fetch_record", [("name", lit("beta"))])),
            bind(
                "merged",
                call(
                    "merge_records",
                    [
                        ("alpha", reference("alpha", "token")),
                        ("beta", reference("beta", "token")),
                    ],
                ),
            ),
            bind(
                "verified",
                call(
                    "verify_merge",
                    [("receipt", reference("merged", "receipt"))],
                ),
            ),
            reply([reference("verified", "delivery_token")]),
        ]),
        expected_tools: strings(&[
            "fetch_record:alpha",
            "fetch_record:beta",
            "merge_records:REC-A-1937:REC-B-7391",
            "verify_merge:MERGED-AB-4472",
        ]),
        dependencies: pairs(&[
            ("fetch_record:alpha", "merge_records:REC-A-1937:REC-B-7391"),
            ("fetch_record:beta", "merge_records:REC-A-1937:REC-B-7391"),
        ]),
        forbidden_tools: Vec::new(),
        final_tokens: strings(&["MERGE-VERIFIED-5208"]),
    }
}

fn guard_no_action_task() -> EvalTask {
    EvalTask {
        id: "guard_no_action",
        program: Program::If {
            left: lit("archival"),
            equals: lit("live"),
            when_true: Box::new(call("forbidden_effect", [("mode", lit("live"))])),
            when_false: Box::new(reply([lit("NO-ACTION-REQUIRED")])),
        },
        expected_tools: Vec::new(),
        dependencies: Vec::new(),
        forbidden_tools: strings(&["forbidden_effect"]),
        final_tokens: strings(&["NO-ACTION-REQUIRED"]),
    }
}

fn seq(steps: Vec<Program>) -> Program {
    Program::Seq { steps }
}

fn bind(name: &str, expression: Program) -> Program {
    Program::Bind {
        name: name.to_string(),
        expression: Box::new(expression),
    }
}

fn call<const N: usize>(tool: &str, arguments: [(&str, Operand); N]) -> Program {
    Program::Call {
        tool: tool.to_string(),
        arguments: arguments
            .into_iter()
            .map(|(name, value)| (name.to_string(), value))
            .collect(),
    }
}

fn reply<const N: usize>(values: [Operand; N]) -> Program {
    Program::Reply {
        values: values.into_iter().collect(),
    }
}

fn lit(value: &str) -> Operand {
    Operand::Literal {
        value: value.to_string(),
    }
}

fn boolean(value: bool) -> Operand {
    Operand::Boolean { value }
}

fn reference(binding: &str, field: &str) -> Operand {
    Operand::Reference {
        binding: binding.to_string(),
        field: field.to_string(),
    }
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn pairs(values: &[(&str, &str)]) -> Vec<(String, String)> {
    values
        .iter()
        .map(|(left, right)| ((*left).to_string(), (*right).to_string()))
        .collect()
}

fn tool_definitions() -> Vec<ToolDefinition> {
    vec![
        tool("make_value", &["name"], &["name", "parent"]),
        tool(
            "verify_chain",
            &["first", "middle", "last"],
            &["first", "middle", "last"],
        ),
        tool("read_case", &["case"], &["case"]),
        tool("route_true", &["case", "token"], &["case", "token"]),
        tool("route_false", &["case", "token"], &["case", "token"]),
        tool(
            "verify_routes",
            &["one", "two", "three", "four"],
            &["one", "two", "three", "four"],
        ),
        tool("probe_endpoint", &["name"], &["name"]),
        tool("verify_endpoint", &["name", "token"], &["name", "token"]),
        tool("fetch_piece", &["key"], &["key"]),
        tool("transform_piece", &["lane", "token"], &["lane", "token"]),
        tool("verify_shared", &["left", "right"], &["left", "right"]),
        tool("fetch_record", &["name"], &["name"]),
        tool("merge_records", &["alpha", "beta"], &["alpha", "beta"]),
        tool("verify_merge", &["receipt"], &["receipt"]),
        tool("forbidden_effect", &["mode"], &["mode"]),
    ]
}

fn tool(name: &str, required: &[&str], properties: &[&str]) -> ToolDefinition {
    let properties = properties
        .iter()
        .map(|name| ((*name).to_string(), json!({"type":"string"})))
        .collect::<serde_json::Map<_, _>>();
    ToolDefinition {
        name: name.to_string(),
        description: format!("Deterministic ME-02 fixture operation `{name}`."),
        parameters: json!({
            "type":"object",
            "properties":properties,
            "required":required,
            "additionalProperties":false
        }),
    }
}

fn execute_tool(name: &str, arguments: &Value) -> Value {
    match name {
        "make_value" => make_value(arguments),
        "verify_chain" => result(
            string(arguments, "first") == "T-A-7319"
                && string(arguments, "middle") == "T-C-9026"
                && string(arguments, "last") == "T-D-4651",
            "CHAIN-VERIFIED-6194",
        ),
        "read_case" => match string(arguments, "case") {
            "C1" => json!({"ok":true,"enabled":true,"token":"Q-C1-8264"}),
            "C2" => json!({"ok":true,"enabled":false,"token":"Q-C2-2684"}),
            "C3" => json!({"ok":true,"enabled":true,"token":"Q-C3-8426"}),
            "C4" => json!({"ok":true,"enabled":false,"token":"Q-C4-2846"}),
            value => json!({"ok":false,"error":"UNKNOWN_CASE","case":value}),
        },
        "route_true" => route(arguments, true),
        "route_false" => route(arguments, false),
        "verify_routes" => result(
            string(arguments, "one") == "RT-C1"
                && string(arguments, "two") == "RF-C2"
                && string(arguments, "three") == "RT-C3"
                && string(arguments, "four") == "RF-C4",
            "ROUTES-VERIFIED-2609",
        ),
        "probe_endpoint" => match string(arguments, "name") {
            "primary" => json!({"ok":false,"error":"PRIMARY_UNAVAILABLE"}),
            "secondary" => json!({"ok":false,"error":"SECONDARY_UNAVAILABLE"}),
            "tertiary" => json!({"ok":true,"name":"tertiary","token":"EP-T-5541"}),
            value => json!({"ok":false,"error":"UNKNOWN_ENDPOINT","name":value}),
        },
        "verify_endpoint" => result(
            string(arguments, "name") == "tertiary" && string(arguments, "token") == "EP-T-5541",
            "ENDPOINT-VERIFIED-7752",
        ),
        "fetch_piece" => match string(arguments, "key") {
            "shared" => json!({"ok":true,"token":"SH-8813"}),
            key => json!({"ok":false,"error":"UNKNOWN_KEY","key":key}),
        },
        "transform_piece" => transform_piece(arguments),
        "verify_shared" => result(
            string(arguments, "left") == "L-8813" && string(arguments, "right") == "R-8813",
            "SHARED-VERIFIED-3490",
        ),
        "fetch_record" => match string(arguments, "name") {
            "alpha" => json!({"ok":true,"token":"REC-A-1937"}),
            "beta" => json!({"ok":true,"token":"REC-B-7391"}),
            value => json!({"ok":false,"error":"UNKNOWN_RECORD","name":value}),
        },
        "merge_records" => {
            if string(arguments, "alpha") == "REC-A-1937"
                && string(arguments, "beta") == "REC-B-7391"
            {
                json!({"ok":true,"receipt":"MERGED-AB-4472"})
            } else {
                json!({"ok":false,"error":"MERGE_INPUT_MISMATCH"})
            }
        }
        "verify_merge" => result(
            string(arguments, "receipt") == "MERGED-AB-4472",
            "MERGE-VERIFIED-5208",
        ),
        "forbidden_effect" => json!({"ok":false,"error":"FORBIDDEN_EFFECT_EXECUTED"}),
        other => json!({"ok":false,"error":"UNKNOWN_TOOL","tool":other}),
    }
}

fn make_value(arguments: &Value) -> Value {
    let name = string(arguments, "name");
    let parent = string(arguments, "parent");
    let (expected_parent, token) = match name {
        "A" => ("", "T-A-7319"),
        "B" => ("T-A-7319", "T-B-1847"),
        "C" => ("T-B-1847", "T-C-9026"),
        "D" => ("T-C-9026", "T-D-4651"),
        _ => return json!({"ok":false,"error":"UNKNOWN_NAME"}),
    };
    if parent == expected_parent {
        json!({"ok":true,"name":name,"token":token})
    } else {
        json!({"ok":false,"error":"PARENT_MISMATCH"})
    }
}

fn route(arguments: &Value, expected_enabled: bool) -> Value {
    let case = string(arguments, "case");
    let token = string(arguments, "token");
    let (enabled, expected_token, receipt) = match case {
        "C1" => (true, "Q-C1-8264", "RT-C1"),
        "C2" => (false, "Q-C2-2684", "RF-C2"),
        "C3" => (true, "Q-C3-8426", "RT-C3"),
        "C4" => (false, "Q-C4-2846", "RF-C4"),
        _ => return json!({"ok":false,"error":"UNKNOWN_CASE"}),
    };
    if enabled == expected_enabled && token == expected_token {
        json!({"ok":true,"receipt":receipt})
    } else {
        json!({"ok":false,"error":"ROUTE_MISMATCH"})
    }
}

fn transform_piece(arguments: &Value) -> Value {
    if string(arguments, "token") != "SH-8813" {
        return json!({"ok":false,"error":"TOKEN_MISMATCH"});
    }
    match string(arguments, "lane") {
        "left" => json!({"ok":true,"receipt":"L-8813"}),
        "right" => json!({"ok":true,"receipt":"R-8813"}),
        _ => json!({"ok":false,"error":"UNKNOWN_LANE"}),
    }
}

fn result(valid: bool, delivery_token: &str) -> Value {
    if valid {
        json!({"ok":true,"delivery_token":delivery_token})
    } else {
        json!({"ok":false,"error":"VERIFICATION_FAILED"})
    }
}

fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn score_episode(task: &EvalTask, trace: &[ToolTrace], final_answer: &str) -> Vec<CriterionResult> {
    let actual = trace.iter().map(trace_key).collect::<Vec<_>>();
    let mut cursor = 0usize;
    let mut missing = Vec::new();
    for expected in &task.expected_tools {
        if let Some(offset) = actual[cursor..]
            .iter()
            .position(|actual| actual == expected)
        {
            cursor += offset + 1;
        } else {
            missing.push(expected.clone());
        }
    }
    let required_tool_order = CriterionResult {
        id: "required-tool-order".to_string(),
        passed: missing.is_empty(),
        evidence: format!("missing={missing:?}; actual={actual:?}"),
    };
    let exact_tool_plan = CriterionResult {
        id: "exact-tool-plan".to_string(),
        passed: actual == task.expected_tools,
        evidence: format!("expected={:?}; actual={actual:?}", task.expected_tools),
    };
    let violations = task
        .dependencies
        .iter()
        .filter_map(|(before, after)| {
            let left = trace
                .iter()
                .find(|entry| trace_key(entry) == *before)
                .map(|entry| entry.attempt);
            let right = trace
                .iter()
                .find(|entry| trace_key(entry) == *after)
                .map(|entry| entry.attempt);
            match (left, right) {
                (Some(left), Some(right)) if left < right => None,
                _ => Some(format!("{before}->{after}:{left:?}->{right:?}")),
            }
        })
        .collect::<Vec<_>>();
    let causal_dataflow = CriterionResult {
        id: "causal-dataflow".to_string(),
        passed: violations.is_empty(),
        evidence: format!("violations={violations:?}"),
    };
    let forbidden = trace
        .iter()
        .filter(|entry| task.forbidden_tools.contains(&entry.name))
        .map(|entry| entry.name.clone())
        .collect::<Vec<_>>();
    let branch_discipline = CriterionResult {
        id: "branch-discipline".to_string(),
        passed: forbidden.is_empty(),
        evidence: format!("forbidden={forbidden:?}"),
    };
    let missing_tokens = task
        .final_tokens
        .iter()
        .filter(|token| !contains_standalone_token(final_answer, token))
        .cloned()
        .collect::<Vec<_>>();
    let final_delivery = CriterionResult {
        id: "final-delivery".to_string(),
        passed: missing_tokens.is_empty(),
        evidence: format!("missing={missing_tokens:?}; final={final_answer:?}"),
    };
    vec![
        required_tool_order,
        exact_tool_plan,
        causal_dataflow,
        branch_discipline,
        final_delivery,
    ]
}

fn trace_key(trace: &ToolTrace) -> String {
    match trace.name.as_str() {
        "make_value" => format!(
            "make_value:{}:{}",
            string(&trace.arguments, "name"),
            string(&trace.arguments, "parent")
        ),
        "verify_chain" => format!(
            "verify_chain:{}:{}:{}",
            string(&trace.arguments, "first"),
            string(&trace.arguments, "middle"),
            string(&trace.arguments, "last")
        ),
        "read_case" | "probe_endpoint" | "fetch_record" => {
            format!(
                "{}:{}",
                trace.name,
                string(&trace.arguments, "case").to_string() + string(&trace.arguments, "name")
            )
        }
        "route_true" | "route_false" => format!(
            "{}:{}:{}",
            trace.name,
            string(&trace.arguments, "case"),
            string(&trace.arguments, "token")
        ),
        "verify_routes" => format!(
            "verify_routes:{}:{}:{}:{}",
            string(&trace.arguments, "one"),
            string(&trace.arguments, "two"),
            string(&trace.arguments, "three"),
            string(&trace.arguments, "four")
        ),
        "verify_endpoint" => format!(
            "verify_endpoint:{}:{}",
            string(&trace.arguments, "name"),
            string(&trace.arguments, "token")
        ),
        "fetch_piece" => format!("fetch_piece:{}", string(&trace.arguments, "key")),
        "transform_piece" => format!(
            "transform_piece:{}:{}",
            string(&trace.arguments, "lane"),
            string(&trace.arguments, "token")
        ),
        "verify_shared" => format!(
            "verify_shared:{}:{}",
            string(&trace.arguments, "left"),
            string(&trace.arguments, "right")
        ),
        "merge_records" => format!(
            "merge_records:{}:{}",
            string(&trace.arguments, "alpha"),
            string(&trace.arguments, "beta")
        ),
        "verify_merge" => format!("verify_merge:{}", string(&trace.arguments, "receipt")),
        other => other.to_string(),
    }
}

fn contains_standalone_token(text: &str, token: &str) -> bool {
    text.match_indices(token).any(|(start, _)| {
        let before = text[..start].chars().next_back();
        let after = text[start + token.len()..].chars().next();
        before.is_none_or(|character| !is_token_character(character))
            && after.is_none_or(|character| !is_token_character(character))
    })
}

fn is_token_character(character: char) -> bool {
    character.is_alphanumeric() || matches!(character, '-' | '_')
}

fn summarize(episodes: &[EpisodeReport]) -> BTreeMap<String, ArmSummary> {
    Arm::ALL
        .iter()
        .map(|arm| {
            let selected = episodes
                .iter()
                .filter(|episode| episode.arm == arm.name())
                .collect::<Vec<_>>();
            let count = selected.len();
            let denominator = count.max(1) as f64;
            let passed = selected.iter().filter(|episode| episode.success).count();
            let semantic_passed = selected
                .iter()
                .filter(|episode| episode.semantic_success)
                .count();
            (
                arm.name().to_string(),
                ArmSummary {
                    episodes: count,
                    passed,
                    pass_rate: passed as f64 / denominator,
                    semantic_passed,
                    semantic_pass_rate: semantic_passed as f64 / denominator,
                    mean_attempts: selected
                        .iter()
                        .map(|episode| episode.attempts as f64)
                        .sum::<f64>()
                        / denominator,
                    mean_tool_calls: selected
                        .iter()
                        .map(|episode| episode.tool_trace.len() as f64)
                        .sum::<f64>()
                        / denominator,
                },
            )
        })
        .collect()
}

fn scorer_accepts_registered_positive(task: &EvalTask) -> bool {
    let trace = task
        .expected_tools
        .iter()
        .enumerate()
        .map(|(index, key)| trace_from_key(index + 1, key))
        .collect::<Option<Vec<_>>>();
    trace.is_some_and(|trace| {
        score_episode(task, &trace, &task.final_tokens.join(" "))
            .iter()
            .all(|criterion| criterion.passed)
    })
}

fn scorer_rejects_registered_negatives(task: &EvalTask) -> bool {
    if task.expected_tools.is_empty() {
        let forbidden = ToolTrace {
            attempt: 1,
            name: "forbidden_effect".to_string(),
            arguments: json!({"mode":"live"}),
            output: json!({"ok":false}),
        };
        return !score_episode(task, &[forbidden], "NO-ACTION-REQUIRED")
            .iter()
            .all(|criterion| criterion.passed);
    }
    let trace = task
        .expected_tools
        .iter()
        .enumerate()
        .map(|(index, key)| trace_from_key(index + 1, key))
        .collect::<Option<Vec<_>>>();
    let Some(mut trace) = trace else {
        return false;
    };
    let wrong_final = format!("prefix-{}-suffix", task.final_tokens[0]);
    let rejects_substring = !score_episode(task, &trace, &wrong_final)
        .iter()
        .all(|criterion| criterion.passed);
    trace.push(trace[0].clone());
    let rejects_extra = !score_episode(task, &trace, &task.final_tokens.join(" "))
        .iter()
        .all(|criterion| criterion.passed);
    let mut parallel = trace[..trace.len() - 1].to_vec();
    for entry in &mut parallel {
        entry.attempt = 1;
    }
    let rejects_guessed_dependency = task.dependencies.is_empty()
        || !score_episode(task, &parallel, &task.final_tokens.join(" "))
            .iter()
            .all(|criterion| criterion.passed);
    rejects_substring && rejects_extra && rejects_guessed_dependency
}

fn trace_from_key(attempt: usize, key: &str) -> Option<ToolTrace> {
    let parts = key.split(':').collect::<Vec<_>>();
    let (name, arguments) = match parts.as_slice() {
        ["make_value", name, parent] => ("make_value", json!({"name":name,"parent":parent})),
        ["verify_chain", first, middle, last] => (
            "verify_chain",
            json!({"first":first,"middle":middle,"last":last}),
        ),
        ["read_case", case] => ("read_case", json!({"case":case})),
        [name @ ("route_true" | "route_false"), case, token] => {
            (*name, json!({"case":case,"token":token}))
        }
        ["verify_routes", one, two, three, four] => (
            "verify_routes",
            json!({"one":one,"two":two,"three":three,"four":four}),
        ),
        ["probe_endpoint", name] => ("probe_endpoint", json!({"name":name})),
        ["verify_endpoint", name, token] => ("verify_endpoint", json!({"name":name,"token":token})),
        ["fetch_piece", key] => ("fetch_piece", json!({"key":key})),
        ["transform_piece", lane, token] => ("transform_piece", json!({"lane":lane,"token":token})),
        ["verify_shared", left, right] => ("verify_shared", json!({"left":left,"right":right})),
        ["fetch_record", name] => ("fetch_record", json!({"name":name})),
        ["merge_records", alpha, beta] => ("merge_records", json!({"alpha":alpha,"beta":beta})),
        ["verify_merge", receipt] => ("verify_merge", json!({"receipt":receipt})),
        _ => return None,
    };
    Some(ToolTrace {
        attempt,
        name: name.to_string(),
        arguments,
        output: json!({"ok":true}),
    })
}

fn hidden_tool_outputs() -> &'static [&'static str] {
    &[
        "T-A-7319",
        "T-B-1847",
        "T-C-9026",
        "T-D-4651",
        "CHAIN-VERIFIED-6194",
        "Q-C1-8264",
        "Q-C2-2684",
        "Q-C3-8426",
        "Q-C4-2846",
        "ROUTES-VERIFIED-2609",
        "EP-T-5541",
        "ENDPOINT-VERIFIED-7752",
        "SH-8813",
        "SHARED-VERIFIED-3490",
        "REC-A-1937",
        "REC-B-7391",
        "MERGED-AB-4472",
        "MERGE-VERIFIED-5208",
    ]
}

fn typed_literal_gate(bundle: &[PromptTaskArtifact]) -> bool {
    let Some(task) = bundle
        .iter()
        .find(|task| task.task == "alternating_branches")
    else {
        return false;
    };
    let sexpr = task.arms.iter().find(|arm| arm.arm == "sexpr_ast");
    let json = task.arms.iter().find(|arm| arm.arm == "json_ast");
    let markdown = task.arms.iter().find(|arm| arm.arm == "markdown_program");
    sexpr.is_some_and(|arm| arm.prompt.contains("(boolean true)"))
        && json.is_some_and(|arm| {
            arm.prompt.contains("\"kind\": \"boolean\"")
                && arm.prompt.contains("\"value\": true")
                && !arm.prompt.contains("\"value\": \"true\"")
        })
        && markdown.is_some_and(|arm| arm.prompt.contains("BOOLEAN `true`"))
}

fn message(role: &str, content: &str) -> Message {
    Message {
        role: role.to_string(),
        content: content.to_string(),
        name: None,
        tool_call_id: None,
        tool_calls: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_arm_renders_the_same_semantic_digest() {
        let bundle = prompt_bundle(&tasks()).unwrap();
        assert_eq!(bundle.len(), 6);
        assert!(bundle.iter().all(|task| {
            task.arms.len() == 3
                && task
                    .arms
                    .iter()
                    .all(|arm| arm.semantic_digest == task.semantic_digest)
        }));
    }

    #[test]
    fn hidden_outputs_do_not_leak_into_visible_prompts() {
        let bundle = prompt_bundle(&tasks()).unwrap();
        for task in bundle {
            for arm in task.arms {
                for hidden in hidden_tool_outputs() {
                    assert!(!arm.prompt.contains(hidden), "{} leaked {hidden}", arm.arm);
                }
            }
        }
    }

    #[test]
    fn booleans_retain_the_same_native_type_in_every_renderer() {
        let bundle = prompt_bundle(&tasks()).unwrap();
        assert!(typed_literal_gate(&bundle));
    }

    #[test]
    fn provider_continuation_is_a_protocol_message_not_visible_text() {
        let continuation = morphz::llm::ProviderContinuation::OpenaiResponses {
            reasoning_items: vec![json!({"type":"reasoning","id":"r1"})],
        };
        let message = provider_continuation_message(continuation).unwrap();
        assert_eq!(
            message.name.as_deref(),
            Some(morphz::llm::PROVIDER_CONTINUATION_MESSAGE_NAME)
        );
        assert_eq!(message.role, "system");
    }

    #[test]
    fn renderer_outputs_are_distinct_and_nonempty() {
        for task in tasks() {
            let rendered = Arm::ALL
                .iter()
                .map(|arm| render_program(&task.program, *arm).unwrap())
                .collect::<Vec<_>>();
            assert!(rendered.iter().all(|value| !value.trim().is_empty()));
            assert_ne!(rendered[0], rendered[1]);
            assert_ne!(rendered[1], rendered[2]);
        }
    }

    #[test]
    fn scorer_accepts_all_registered_positive_traces() {
        assert!(tasks().iter().all(scorer_accepts_registered_positive));
    }

    #[test]
    fn scorer_rejects_registered_negative_traces() {
        assert!(tasks().iter().all(scorer_rejects_registered_negatives));
    }
}
