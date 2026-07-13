use chrono::Utc;
use morphz::config::{self, AppConfig};
use morphz::llm::{Client, FunctionCall, Message, OpenAIClient, ToolCall, ToolDefinition};
use morphz::sexpr_vm_contract::ANNOTATED_REPLY_KERNEL;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

type DynError = Box<dyn std::error::Error + Send + Sync>;

const MAX_ATTEMPTS: usize = 16;
const MAX_PROTOCOL_RETRIES: usize = 2;
const EMPTY_RESPONSE_ERROR: &str = "既没有非空正文，也没有工具调用";
const REPLY_PROTOCOL_ERROR: &str = "Protocol error: this evaluation has not completed because the response did not make a valid reply decision. Continue the remaining S-expression and call the standard reply tool exactly once. Use disposition=deliver with non-empty content, or disposition=suppress when no Session message is needed. Plain text and an empty response do not complete this evaluation.";

const EXTERNAL_NL_VM: &str = "You are the semantic processor of a Cognitive S-Expression VM. Evaluate the supplied S-expression through real standard Function Calling. Evaluate seq left-to-right; fallback uses its backup only after primary failure; bind stores exact observed results in local scope; if evaluates exactly one branch; named process calls have independent local scope. Every evaluation path must end by calling the standard reply tool exactly once. Use disposition=deliver with non-empty content to send a Session response, or disposition=suppress when no Session response is needed. Plain text and empty output are not terminal reply decisions. Tool results are authoritative observations; never explain or simulate the form instead of evaluating it.";

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum Arm {
    AnnotatedKernel,
    ExternalNlVm,
}

impl Arm {
    const ALL: [Self; 2] = [Self::AnnotatedKernel, Self::ExternalNlVm];

    fn name(self) -> &'static str {
        match self {
            Self::AnnotatedKernel => "annotated_kernel",
            Self::ExternalNlVm => "external_nl_vm",
        }
    }

    fn system_prompt(self) -> &'static str {
        match self {
            Self::AnnotatedKernel => ANNOTATED_REPLY_KERNEL,
            Self::ExternalNlVm => EXTERNAL_NL_VM,
        }
    }
}

#[derive(Clone)]
struct EvalTask {
    id: &'static str,
    sexpr: &'static str,
    expected_tools: &'static [&'static str],
    dependencies: &'static [(&'static str, &'static str)],
    forbidden_tools: &'static [&'static str],
    expected_disposition: &'static str,
    final_tokens: &'static [&'static str],
}

#[derive(Debug, Serialize)]
pub struct ToolTrace {
    pub attempt: usize,
    pub name: String,
    pub arguments: Value,
    pub output: Value,
}

#[derive(Debug, Serialize)]
pub struct CriterionResult {
    pub id: String,
    pub passed: bool,
    pub evidence: String,
}

#[derive(Debug, Serialize)]
pub struct EpisodeReport {
    pub run: usize,
    pub arm: String,
    pub task: String,
    pub clean_success: bool,
    pub outcome_success: bool,
    pub recovered_success: bool,
    pub score: u32,
    pub max_score: u32,
    pub attempts: usize,
    pub protocol_errors: usize,
    pub system_prompt_chars: usize,
    pub task_prompt_chars: usize,
    pub reply_disposition: Option<String>,
    pub reply_content: Option<String>,
    pub tool_trace: Vec<ToolTrace>,
    pub error: Option<String>,
    pub criteria: Vec<CriterionResult>,
}

#[derive(Debug, Serialize)]
pub struct ArmSummary {
    pub episodes: usize,
    pub clean_passed: usize,
    pub clean_pass_rate: f64,
    pub outcome_passed: usize,
    pub outcome_pass_rate: f64,
    pub recovered_passed: usize,
    pub recovered_pass_rate: f64,
    pub mean_attempts: f64,
    pub mean_tool_calls: f64,
    pub mean_protocol_errors: f64,
}

#[derive(Debug, Serialize)]
pub struct ReplyEvalReport {
    pub id: String,
    pub created_at: String,
    pub model: String,
    pub repetitions: usize,
    pub max_protocol_retries: usize,
    pub output_dir: PathBuf,
    pub summaries: BTreeMap<String, ArmSummary>,
    pub episodes: Vec<EpisodeReport>,
    pub conclusion_boundary: String,
}

pub async fn run_reply_eval(
    output_base: &Path,
    repetitions: usize,
) -> Result<ReplyEvalReport, DynError> {
    if repetitions == 0 {
        return Err("repetitions 必须大于 0".into());
    }
    let _ = config::load_env(".env");
    let api_key = std::env::var("OPENAI_API_KEY")?;
    let base_url = std::env::var("OPENAI_BASE_URL").unwrap_or_default();
    let app_config = AppConfig::load_or_default("morphz.toml");
    let model = std::env::var("OPENAI_MODEL").unwrap_or_else(|_| app_config.llm.model.clone());
    let client = OpenAIClient::new_with_config(api_key, base_url, model.clone(), &app_config.llm)?;
    let id = format!(
        "sexpr-explicit-reply-ab-v1-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    );
    let output_dir = output_base.join(&id);
    std::fs::create_dir_all(&output_dir)?;

    let mut episodes = Vec::new();
    for run in 1..=repetitions {
        for task in tasks() {
            let rotation = (run - 1) % Arm::ALL.len();
            for offset in 0..Arm::ALL.len() {
                let arm = Arm::ALL[(rotation + offset) % Arm::ALL.len()];
                let report = run_episode(&client, run, arm, &task).await?;
                std::fs::write(
                    output_dir.join(format!("run-{run}-{}-{}.json", task.id, arm.name())),
                    serde_json::to_vec_pretty(&report)?,
                )?;
                episodes.push(report);
            }
        }
    }

    let report = ReplyEvalReport {
        id,
        created_at: Utc::now().to_rfc3339(),
        model,
        repetitions,
        max_protocol_retries: MAX_PROTOCOL_RETRIES,
        output_dir: output_dir.clone(),
        summaries: summarize(&episodes),
        episodes,
        conclusion_boundary: "该基准只比较 SExpr 内算子描述与外部自然语言 VM 契约在显式 reply(deliver/suppress) 协议下的行为。普通文本和空响应不是终止；Runtime 最多纠错重试两次。确定性工具隔离了真实网络和业务质量。".to_string(),
    };
    std::fs::write(
        output_dir.join("report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(report)
}

async fn run_episode(
    client: &dyn Client,
    run: usize,
    arm: Arm,
    task: &EvalTask,
) -> Result<EpisodeReport, DynError> {
    let mut messages = vec![
        message("system", arm.system_prompt()),
        message("user", task.sexpr),
    ];
    let definitions = tool_definitions();
    let mut trace = Vec::new();
    let mut reply_disposition = None;
    let mut reply_content = None;
    let mut episode_error = None;
    let mut attempts = 0usize;
    let mut protocol_errors = 0usize;

    for attempt in 1..=MAX_ATTEMPTS {
        attempts = attempt;
        let response = match client
            .create_completion(messages.clone(), definitions.clone())
            .await
        {
            Ok(response) => response,
            Err(error) if error.to_string().contains(EMPTY_RESPONSE_ERROR) => {
                protocol_errors += 1;
                if protocol_errors > MAX_PROTOCOL_RETRIES {
                    episode_error = Some(format!(
                        "reply protocol circuit breaker after {protocol_errors} invalid responses"
                    ));
                    break;
                }
                messages.push(message("user", REPLY_PROTOCOL_ERROR));
                continue;
            }
            Err(error) => {
                episode_error = Some(error.to_string());
                break;
            }
        };

        if response.tool_calls.is_empty() {
            protocol_errors += 1;
            if !response.content.trim().is_empty() {
                messages.push(message("assistant", &response.content));
            }
            if protocol_errors > MAX_PROTOCOL_RETRIES {
                episode_error = Some(format!(
                    "reply protocol circuit breaker after {protocol_errors} invalid responses"
                ));
                break;
            }
            messages.push(message("user", REPLY_PROTOCOL_ERROR));
            continue;
        }

        let reply_calls = response
            .tool_calls
            .iter()
            .filter(|call| call.func_name == "reply")
            .collect::<Vec<_>>();
        if !reply_calls.is_empty() {
            if response.tool_calls.len() != 1 {
                protocol_errors += 1;
                if protocol_errors > MAX_PROTOCOL_RETRIES {
                    episode_error = Some(format!(
                        "reply protocol circuit breaker after {protocol_errors} invalid responses"
                    ));
                    break;
                }
                messages.push(message(
                    "user",
                    "Protocol error: reply must be the only tool call in its terminal response. Continue evaluation and call reply exactly once after all other tools have completed.",
                ));
                continue;
            }

            let call = reply_calls[0];
            let arguments = serde_json::from_str::<Value>(&call.arguments)
                .unwrap_or_else(|_| json!({"_invalid_json":call.arguments}));
            match validate_reply(&arguments) {
                Ok((disposition, content)) => {
                    let delivered = disposition == "deliver";
                    trace.push(ToolTrace {
                        attempt,
                        name: "reply".to_string(),
                        arguments: arguments.clone(),
                        output: json!({"ok":true,"delivered":delivered}),
                    });
                    reply_disposition = Some(disposition.to_string());
                    reply_content = content.map(ToOwned::to_owned);
                    break;
                }
                Err(reason) => {
                    protocol_errors += 1;
                    if protocol_errors > MAX_PROTOCOL_RETRIES {
                        episode_error = Some(format!(
                            "reply protocol circuit breaker after {protocol_errors} invalid responses: {reason}"
                        ));
                        break;
                    }
                    messages.push(message(
                        "user",
                        &format!("Protocol error: invalid reply arguments: {reason}. {REPLY_PROTOCOL_ERROR}"),
                    ));
                    continue;
                }
            }
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
                arguments: arguments.clone(),
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

    if reply_disposition.is_none() && episode_error.is_none() {
        episode_error = Some(format!(
            "attempt budget exhausted without reply after {attempts} attempts"
        ));
    }
    let criteria = score_episode(task, &trace, protocol_errors);
    let score = criteria.iter().filter(|criterion| criterion.passed).count() as u32;
    let max_score = criteria.len() as u32;
    let outcome_success = criteria
        .iter()
        .filter(|criterion| {
            !matches!(
                criterion.id.as_str(),
                "exact-tool-plan" | "no-protocol-retry"
            )
        })
        .all(|criterion| criterion.passed);
    let clean_success = criteria.iter().all(|criterion| criterion.passed);
    let recovered_success = outcome_success && !clean_success;
    Ok(EpisodeReport {
        run,
        arm: arm.name().to_string(),
        task: task.id.to_string(),
        clean_success,
        outcome_success,
        recovered_success,
        score,
        max_score,
        attempts,
        protocol_errors,
        system_prompt_chars: arm.system_prompt().chars().count(),
        task_prompt_chars: task.sexpr.chars().count(),
        reply_disposition,
        reply_content,
        tool_trace: trace,
        error: episode_error,
        criteria,
    })
}

fn validate_reply(arguments: &Value) -> Result<(&str, Option<&str>), String> {
    let disposition = arguments
        .get("disposition")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing disposition".to_string())?;
    match disposition {
        "deliver" => {
            let content = arguments
                .get("content")
                .and_then(Value::as_str)
                .filter(|content| !content.trim().is_empty())
                .ok_or_else(|| "deliver requires non-empty content".to_string())?;
            Ok((disposition, Some(content)))
        }
        "suppress" => Ok((disposition, None)),
        other => Err(format!("unsupported disposition {other:?}")),
    }
}

fn tasks() -> Vec<EvalTask> {
    vec![
        EvalTask {
            id: "linear-discovery",
            sexpr: "(seq (bind capabilities (call skills_list)) (bind skill (if (contains capabilities.skills (name smart-search) (cap find web live news)) smart-search (reply no-reply))) (bind skill-spec (call skill_view (name skill))) (bind result (call skill_run (name skill) (input Nova-7))) (bind verification (call evidence_verify (evidence_id result.evidence_id))) (reply verification.delivery_token))",
            expected_tools: &["skills_list", "skill_view:smart-search", "skill_run:smart-search:Nova-7", "evidence_verify:E-NOVA", "reply:deliver:D-7Q4M-9182"],
            dependencies: &[("skills_list", "skill_view:smart-search"), ("skill_view:smart-search", "skill_run:smart-search:Nova-7"), ("skill_run:smart-search:Nova-7", "evidence_verify:E-NOVA"), ("evidence_verify:E-NOVA", "reply:deliver:D-7Q4M-9182")],
            forbidden_tools: &[],
            expected_disposition: "deliver",
            final_tokens: &["D-7Q4M-9182"],
        },
        EvalTask {
            id: "conditional-fallback",
            sexpr: "(seq (bind capabilities (call skills_list)) (bind primary-spec (call skill_view (name smart-search))) (bind search-result (fallback (call skill_run (name smart-search) (input Orion-9)) (seq (bind fallback-spec (call skill_view (name browser-research))) (call skill_run (name browser-research) (input Orion-9))))) (bind verification (call evidence_verify (evidence_id search-result.evidence_id))) (reply verification.delivery_token))",
            expected_tools: &["skills_list", "skill_view:smart-search", "skill_run:smart-search:Orion-9", "skill_view:browser-research", "skill_run:browser-research:Orion-9", "evidence_verify:E-ORION", "reply:deliver:D-2K9R-6417"],
            dependencies: &[("skills_list", "skill_view:smart-search"), ("skill_view:smart-search", "skill_run:smart-search:Orion-9"), ("skill_run:smart-search:Orion-9", "skill_view:browser-research"), ("skill_view:browser-research", "skill_run:browser-research:Orion-9"), ("skill_run:browser-research:Orion-9", "evidence_verify:E-ORION"), ("evidence_verify:E-ORION", "reply:deliver:D-2K9R-6417")],
            forbidden_tools: &[],
            expected_disposition: "deliver",
            final_tokens: &["D-2K9R-6417"],
        },
        EvalTask {
            id: "module-reuse",
            sexpr: "(process research-one (params subject) (seq (bind search-result (call skill_run (name smart-search) (input subject))) (call evidence_verify (evidence_id search-result.evidence_id))))\n\n(seq (bind capabilities (call skills_list)) (bind skill-spec (call skill_view (name smart-search))) (bind alpha-result (research-one Alpha-1)) (bind beta-result (research-one Beta-2)) (reply (tokens alpha-result.delivery_token beta-result.delivery_token)))",
            expected_tools: &["skills_list", "skill_view:smart-search", "skill_run:smart-search:Alpha-1", "evidence_verify:E-ALPHA", "skill_run:smart-search:Beta-2", "evidence_verify:E-BETA", "reply:deliver:D-8P3A-2754:D-5T1B-8036"],
            dependencies: &[("skills_list", "skill_view:smart-search"), ("skill_view:smart-search", "skill_run:smart-search:Alpha-1"), ("skill_run:smart-search:Alpha-1", "evidence_verify:E-ALPHA"), ("evidence_verify:E-ALPHA", "skill_run:smart-search:Beta-2"), ("skill_run:smart-search:Beta-2", "evidence_verify:E-BETA"), ("evidence_verify:E-BETA", "reply:deliver:D-8P3A-2754:D-5T1B-8036")],
            forbidden_tools: &[],
            expected_disposition: "deliver",
            final_tokens: &["D-8P3A-2754", "D-5T1B-8036"],
        },
        EvalTask {
            id: "guard-no-action",
            sexpr: "(bind input (record (kind archived) (freshness archival)))\n\n(if (= input.freshness live) (seq (call skills_list) (call skill_run)) (reply ARCHIVE-DIRECT))",
            expected_tools: &["reply:deliver:ARCHIVE-DIRECT"],
            dependencies: &[],
            forbidden_tools: &["skills_list", "skill_view", "skill_run", "evidence_verify"],
            expected_disposition: "deliver",
            final_tokens: &["ARCHIVE-DIRECT"],
        },
        EvalTask {
            id: "explicit-no-reply",
            sexpr: "(bind event (record (kind background-cache-refresh) (requires-session-reply false)))\n\n(if event.requires-session-reply (reply CACHE-REFRESHED) (reply no-reply))",
            expected_tools: &["reply:suppress"],
            dependencies: &[],
            forbidden_tools: &["skills_list", "skill_view", "skill_run", "evidence_verify"],
            expected_disposition: "suppress",
            final_tokens: &[],
        },
    ]
}

fn tool_definitions() -> Vec<ToolDefinition> {
    vec![
        tool("skills_list", "List compact deterministic skill capability signatures.", json!({"type":"object","properties":{}})),
        tool("skill_view", "Load the operational content of one skill before using it.", json!({"type":"object","properties":{"name":{"type":"string"}},"required":["name"]})),
        tool("skill_run", "Apply a loaded skill to an input. Tool output is authoritative for success or failure.", json!({"type":"object","properties":{"name":{"type":"string"},"input":{"type":"string"}},"required":["name","input"]})),
        tool("evidence_verify", "Verify one evidence ID and return its opaque delivery token.", json!({"type":"object","properties":{"evidence_id":{"type":"string"}},"required":["evidence_id"]})),
        tool("reply", "Resolve the current Session reply obligation. Use deliver with non-empty content to send a message, or suppress to explicitly finish without external delivery. This terminal tool must be called exactly once after all other work.", json!({"type":"object","properties":{"disposition":{"type":"string","enum":["deliver","suppress"]},"content":{"type":"string"}},"required":["disposition"],"additionalProperties":false})),
    ]
}

fn tool(name: &str, description: &str, parameters: Value) -> ToolDefinition {
    ToolDefinition {
        name: name.to_string(),
        description: description.to_string(),
        parameters,
    }
}

fn execute_tool(name: &str, arguments: &Value) -> Value {
    match name {
        "skills_list" => {
            json!({"skills":[{"name":"local-file-search","cap":"find local static code","effects":"local-read"},{"name":"smart-search","cap":"find web live news zh","effects":"network-read"},{"name":"browser-research","cap":"find web live fallback","effects":"browser-read"}]})
        }
        "skill_view" => match string(arguments, "name") {
            "smart-search" => {
                json!({"name":"smart-search","procedure":"Call skill_run(name=smart-search,input=<subject>). If it returns AUTH_REQUIRED, use an available fallback skill. Verify successful evidence before replying."})
            }
            "browser-research" => {
                json!({"name":"browser-research","procedure":"Call skill_run(name=browser-research,input=<subject>), then verify successful evidence before replying."})
            }
            other if !other.is_empty() => json!({"error":"UNKNOWN_SKILL","name":other}),
            _ => json!({"error":"MISSING_NAME"}),
        },
        "skill_run" => {
            let skill = string(arguments, "name");
            let input = string(arguments, "input");
            if skill == "smart-search" && input == "Orion-9" {
                json!({"ok":false,"error":"AUTH_REQUIRED"})
            } else if skill == "browser-research" && input == "Orion-9" {
                json!({"ok":true,"evidence_id":"E-ORION","source":"browser"})
            } else if skill == "smart-search" {
                let evidence_id = match input {
                    "Nova-7" => "E-NOVA",
                    "Alpha-1" => "E-ALPHA",
                    "Beta-2" => "E-BETA",
                    _ => "E-UNKNOWN",
                };
                json!({"ok":true,"evidence_id":evidence_id,"source":"smart-search"})
            } else {
                json!({"ok":false,"error":"UNSUPPORTED_SKILL_OR_INPUT"})
            }
        }
        "evidence_verify" => match string(arguments, "evidence_id") {
            "E-NOVA" => json!({"verified":true,"delivery_token":"D-7Q4M-9182"}),
            "E-ORION" => json!({"verified":true,"delivery_token":"D-2K9R-6417"}),
            "E-ALPHA" => json!({"verified":true,"delivery_token":"D-8P3A-2754"}),
            "E-BETA" => json!({"verified":true,"delivery_token":"D-5T1B-8036"}),
            other if !other.is_empty() => {
                json!({"verified":false,"error":"UNKNOWN_EVIDENCE","evidence_id":other})
            }
            _ => json!({"verified":false,"error":"MISSING_EVIDENCE_ID"}),
        },
        other => json!({"error":"UNKNOWN_TOOL","name":other}),
    }
}

fn score_episode(
    task: &EvalTask,
    trace: &[ToolTrace],
    protocol_errors: usize,
) -> Vec<CriterionResult> {
    let actual = trace.iter().map(trace_key).collect::<Vec<_>>();
    let expected = task
        .expected_tools
        .iter()
        .map(|entry| (*entry).to_string())
        .collect::<Vec<_>>();
    let mut cursor = 0usize;
    let mut missing = Vec::new();
    for item in &expected {
        if let Some(offset) = actual[cursor..].iter().position(|value| value == item) {
            cursor += offset + 1;
        } else {
            missing.push(item.clone());
        }
    }
    let dependency_violations = task
        .dependencies
        .iter()
        .filter_map(|(producer, consumer)| {
            let producer_attempt = trace
                .iter()
                .find(|entry| trace_key(entry) == *producer)
                .map(|entry| entry.attempt);
            let consumer_attempt = trace
                .iter()
                .find(|entry| trace_key(entry) == *consumer)
                .map(|entry| entry.attempt);
            match (producer_attempt, consumer_attempt) {
                (Some(left), Some(right)) if left < right => None,
                _ => Some(format!(
                    "{producer}@{producer_attempt:?} !< {consumer}@{consumer_attempt:?}"
                )),
            }
        })
        .collect::<Vec<_>>();
    let forbidden = trace
        .iter()
        .filter(|entry| task.forbidden_tools.contains(&entry.name.as_str()))
        .map(|entry| entry.name.clone())
        .collect::<Vec<_>>();
    let reply = trace.iter().find(|entry| entry.name == "reply");
    let reply_disposition = reply.map(|entry| string(&entry.arguments, "disposition"));
    let reply_content = reply.map(|entry| string(&entry.arguments, "content"));
    let reply_valid = reply_disposition == Some(task.expected_disposition)
        && task.final_tokens.iter().all(|token| {
            reply_content.is_some_and(|content| contains_standalone_token(content, token))
        });
    vec![
        CriterionResult {
            id: "required-tool-order".to_string(),
            passed: missing.is_empty(),
            evidence: format!("missing={missing:?}; actual={actual:?}"),
        },
        CriterionResult {
            id: "exact-tool-plan".to_string(),
            passed: actual == expected,
            evidence: format!("expected={expected:?}; actual={actual:?}"),
        },
        CriterionResult {
            id: "causal-rounds".to_string(),
            passed: dependency_violations.is_empty(),
            evidence: format!("violations={dependency_violations:?}"),
        },
        CriterionResult {
            id: "branch-discipline".to_string(),
            passed: forbidden.is_empty(),
            evidence: format!("forbidden_calls={forbidden:?}"),
        },
        CriterionResult {
            id: "reply-decision".to_string(),
            passed: reply_valid,
            evidence: format!(
                "expected_disposition={:?}; expected_tokens={:?}; disposition={reply_disposition:?}; content={reply_content:?}",
                task.expected_disposition, task.final_tokens
            ),
        },
        CriterionResult {
            id: "no-protocol-retry".to_string(),
            passed: protocol_errors == 0,
            evidence: format!("protocol_errors={protocol_errors}"),
        },
    ]
}

fn trace_key(trace: &ToolTrace) -> String {
    match trace.name.as_str() {
        "skill_view" => format!("skill_view:{}", string(&trace.arguments, "name")),
        "skill_run" => format!(
            "skill_run:{}:{}",
            string(&trace.arguments, "name"),
            string(&trace.arguments, "input")
        ),
        "evidence_verify" => format!(
            "evidence_verify:{}",
            string(&trace.arguments, "evidence_id")
        ),
        "reply" => {
            let disposition = string(&trace.arguments, "disposition");
            if disposition == "suppress" {
                "reply:suppress".to_string()
            } else {
                let content = string(&trace.arguments, "content");
                let tokens = [
                    "D-7Q4M-9182",
                    "D-2K9R-6417",
                    "D-8P3A-2754",
                    "D-5T1B-8036",
                    "ARCHIVE-DIRECT",
                ]
                .into_iter()
                .filter(|token| contains_standalone_token(content, token))
                .collect::<Vec<_>>()
                .join(":");
                format!("reply:deliver:{tokens}")
            }
        }
        other => other.to_string(),
    }
}

fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
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
    let mut summaries = BTreeMap::new();
    for arm in Arm::ALL {
        let selected = episodes
            .iter()
            .filter(|episode| episode.arm == arm.name())
            .collect::<Vec<_>>();
        let count = selected.len();
        let denominator = count.max(1) as f64;
        let clean_passed = selected
            .iter()
            .filter(|episode| episode.clean_success)
            .count();
        let outcome_passed = selected
            .iter()
            .filter(|episode| episode.outcome_success)
            .count();
        let recovered_passed = selected
            .iter()
            .filter(|episode| episode.recovered_success)
            .count();
        summaries.insert(
            arm.name().to_string(),
            ArmSummary {
                episodes: count,
                clean_passed,
                clean_pass_rate: clean_passed as f64 / denominator,
                outcome_passed,
                outcome_pass_rate: outcome_passed as f64 / denominator,
                recovered_passed,
                recovered_pass_rate: recovered_passed as f64 / denominator,
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
                mean_protocol_errors: selected
                    .iter()
                    .map(|episode| episode.protocol_errors as f64)
                    .sum::<f64>()
                    / denominator,
            },
        );
    }
    summaries
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
    fn reply_validation_distinguishes_delivery_and_suppression() {
        assert_eq!(
            validate_reply(&json!({"disposition":"deliver","content":"done"})),
            Ok(("deliver", Some("done")))
        );
        assert_eq!(
            validate_reply(&json!({"disposition":"suppress"})),
            Ok(("suppress", None))
        );
        assert!(validate_reply(&json!({"disposition":"deliver","content":""})).is_err());
    }

    #[test]
    fn explicit_no_reply_is_a_valid_clean_terminal_decision() {
        let task = tasks().remove(4);
        let trace = vec![ToolTrace {
            attempt: 1,
            name: "reply".to_string(),
            arguments: json!({"disposition":"suppress"}),
            output: json!({"ok":true,"delivered":false}),
        }];
        assert!(score_episode(&task, &trace, 0)
            .iter()
            .all(|criterion| criterion.passed));
    }

    #[test]
    fn corrected_reply_is_outcome_success_but_not_clean() {
        let task = tasks().remove(3);
        let trace = vec![ToolTrace {
            attempt: 2,
            name: "reply".to_string(),
            arguments: json!({"disposition":"deliver","content":"ARCHIVE-DIRECT"}),
            output: json!({"ok":true,"delivered":true}),
        }];
        let criteria = score_episode(&task, &trace, 1);
        assert!(criteria
            .iter()
            .filter(|criterion| criterion.id != "no-protocol-retry")
            .all(|criterion| criterion.passed));
        assert!(
            !criteria
                .iter()
                .find(|criterion| criterion.id == "no-protocol-retry")
                .expect("no-protocol-retry criterion")
                .passed
        );
    }
}
