use chrono::Utc;
use morphz::config::{self, AppConfig};
use morphz::llm::{Client, FunctionCall, Message, OpenAIClient, ToolCall, ToolDefinition};
use morphz::sexpr_vm_contract::{ANNOTATED_KERNEL, SYMBOLIC_KERNEL};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

type DynError = Box<dyn std::error::Error + Send + Sync>;

const MAX_ATTEMPTS: usize = 12;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum Arm {
    ExternalNlVm,
    BareReadable,
    SymbolicKernel,
    AnnotatedKernel,
    DirectProse,
}

impl Arm {
    const ALL: [Self; 5] = [
        Self::ExternalNlVm,
        Self::BareReadable,
        Self::SymbolicKernel,
        Self::AnnotatedKernel,
        Self::DirectProse,
    ];

    fn name(self) -> &'static str {
        match self {
            Self::ExternalNlVm => "external_nl_vm",
            Self::BareReadable => "bare_readable",
            Self::SymbolicKernel => "symbolic_kernel",
            Self::AnnotatedKernel => "annotated_kernel",
            Self::DirectProse => "direct_prose",
        }
    }

    fn system_prompt(self) -> &'static str {
        match self {
            Self::ExternalNlVm => "You are the semantic processor of a Cognitive S-Expression VM. A user-provided S-expression is executable semantic control state for you to evaluate through real actions. Evaluate (seq ...) from left to right; (call TOOL ...) emits a standard function call; (fallback A B) evaluates B only when A reports failure; (bind NAME EXPR) binds the exact result in local scope; (if CONDITION A B) evaluates exactly one branch; and (reply CONTENT) emits the final tool-free answer. A named (process ...) has parameters, local bindings, and returns its last expression. Tool results are authoritative observations. Never merely explain, quote, or simulate the form.",
            Self::BareReadable | Self::DirectProse => "You are a tool-using agent.",
            Self::SymbolicKernel => SYMBOLIC_KERNEL,
            Self::AnnotatedKernel => ANNOTATED_KERNEL,
        }
    }

    fn task_prompt(self, task: &EvalTask) -> String {
        match self {
            Self::DirectProse => task.prose.to_string(),
            Self::ExternalNlVm
            | Self::BareReadable
            | Self::SymbolicKernel
            | Self::AnnotatedKernel => task.sexpr.to_string(),
        }
    }
}

#[derive(Clone)]
struct EvalTask {
    id: &'static str,
    prose: &'static str,
    sexpr: &'static str,
    expected_tools: &'static [&'static str],
    dependencies: &'static [(&'static str, &'static str)],
    forbidden_tools: &'static [&'static str],
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
    pub success: bool,
    pub semantic_success: bool,
    pub score: u32,
    pub max_score: u32,
    pub attempts: usize,
    pub system_prompt_chars: usize,
    pub task_prompt_chars: usize,
    pub tool_trace: Vec<ToolTrace>,
    pub final_answer: String,
    pub error: Option<String>,
    pub criteria: Vec<CriterionResult>,
}

#[derive(Debug, Serialize)]
pub struct ArmSummary {
    pub episodes: usize,
    pub passed: usize,
    pub pass_rate: f64,
    pub semantic_passed: usize,
    pub semantic_pass_rate: f64,
    pub mean_score: f64,
    pub mean_attempts: f64,
    pub mean_tool_calls: f64,
}

#[derive(Debug, Serialize)]
pub struct ProcessEvalReport {
    pub id: String,
    pub created_at: String,
    pub model: String,
    pub repetitions: usize,
    pub output_dir: PathBuf,
    pub summaries: BTreeMap<String, ArmSummary>,
    pub episodes: Vec<EpisodeReport>,
    pub conclusion_boundary: String,
}

pub async fn run_process_eval(
    output_base: &Path,
    repetitions: usize,
) -> Result<ProcessEvalReport, DynError> {
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
        "sexpr-semantic-vm-ablation-v4-{}-{}",
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
    let summaries = summarize(&episodes);
    let report = ProcessEvalReport {
        id,
        created_at: Utc::now().to_rfc3339(),
        model,
        repetitions,
        output_dir: output_dir.clone(),
        summaries,
        episodes,
        conclusion_boundary: "该基准比较外部自然语言 VM、裸可读 SExpr、纯符号 Kernel、SExpr 内自然语言算子定义和等价自然语言过程，只验证模型能否把过程映射为标准 Function Calling；确定性模拟工具隔离了网络、权限和真实 Skill 内容质量。它不证明完整 Skill DSL、自动抽象或真实任务质量。".to_string(),
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
    let task_prompt = arm.task_prompt(task);
    let mut messages = vec![
        message("system", arm.system_prompt()),
        message("user", &task_prompt),
    ];
    let definitions = tool_definitions();
    let mut trace = Vec::new();
    let mut final_answer = String::new();
    let mut episode_error = None;
    let mut attempts = 0;

    for attempt in 1..=MAX_ATTEMPTS {
        attempts = attempt;
        let response = match client
            .create_completion(messages.clone(), definitions.clone())
            .await
        {
            Ok(response) => response,
            Err(error) => {
                episode_error = Some(error.to_string());
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
        messages.push(Message {
            role: "assistant".to_string(),
            content: response.content,
            name: None,
            tool_call_id: None,
            tool_calls: Some(calls),
        });
        for call in response.tool_calls {
            let arguments = serde_json::from_str::<Value>(&call.arguments)
                .unwrap_or_else(|_| json!({"_invalid_json": call.arguments}));
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

    let criteria = score_episode(task, &trace, &final_answer);
    let score = criteria.iter().filter(|criterion| criterion.passed).count() as u32;
    let max_score = criteria.len() as u32;
    let semantic_success = criteria
        .iter()
        .filter(|criterion| criterion.id != "exact-tool-plan")
        .all(|criterion| criterion.passed);
    Ok(EpisodeReport {
        run,
        arm: arm.name().to_string(),
        task: task.id.to_string(),
        success: score == max_score,
        semantic_success,
        score,
        max_score,
        attempts,
        system_prompt_chars: arm.system_prompt().chars().count(),
        task_prompt_chars: task_prompt.chars().count(),
        tool_trace: trace,
        final_answer,
        error: episode_error,
        criteria,
    })
}

fn tasks() -> Vec<EvalTask> {
    vec![
        EvalTask {
            id: "linear-discovery",
            prose: "Operational procedure, not a topic for discussion. Research the live Nova-7 launch. First call skills_list. Select the skill covering live web news, call skill_view for it, run it with input Nova-7, verify the returned evidence with evidence_verify, and only then answer with the delivery token from verification.",
            sexpr: "(seq (bind capabilities (call skills_list)) (bind skill (if (contains capabilities.skills (name smart-search) (cap find web live news)) smart-search (reply NO-MATCHING-SKILL))) (bind skill-spec (call skill_view (name skill))) (bind result (call skill_run (name skill) (input Nova-7))) (bind verification (call evidence_verify (evidence_id result.evidence_id))) (reply verification.delivery_token))",
            expected_tools: &["skills_list", "skill_view:smart-search", "skill_run:smart-search:Nova-7", "evidence_verify:E-NOVA"],
            dependencies: &[
                ("skills_list", "skill_view:smart-search"),
                ("skill_view:smart-search", "skill_run:smart-search:Nova-7"),
                ("skill_run:smart-search:Nova-7", "evidence_verify:E-NOVA"),
            ],
            forbidden_tools: &[],
            final_tokens: &["NOVA-VERIFIED"],
        },
        EvalTask {
            id: "conditional-fallback",
            prose: "Operational procedure, not a topic for discussion. Research Orion-9. List skills, inspect smart-search, and run smart-search first. If and only if it reports AUTH_REQUIRED, inspect browser-research and run browser-research on Orion-9 instead. Verify the successful evidence and answer with its delivery token. Do not stop at the first failure.",
            sexpr: "(seq (bind capabilities (call skills_list)) (bind primary-spec (call skill_view (name smart-search))) (bind search-result (fallback (call skill_run (name smart-search) (input Orion-9)) (seq (bind fallback-spec (call skill_view (name browser-research))) (call skill_run (name browser-research) (input Orion-9))))) (bind verification (call evidence_verify (evidence_id search-result.evidence_id))) (reply verification.delivery_token))",
            expected_tools: &["skills_list", "skill_view:smart-search", "skill_run:smart-search:Orion-9", "skill_view:browser-research", "skill_run:browser-research:Orion-9", "evidence_verify:E-ORION"],
            dependencies: &[
                ("skills_list", "skill_view:smart-search"),
                ("skill_view:smart-search", "skill_run:smart-search:Orion-9"),
                ("skill_run:smart-search:Orion-9", "skill_view:browser-research"),
                ("skill_view:browser-research", "skill_run:browser-research:Orion-9"),
                ("skill_run:browser-research:Orion-9", "evidence_verify:E-ORION"),
            ],
            forbidden_tools: &[],
            final_tokens: &["ORION-VERIFIED"],
        },
        EvalTask {
            id: "module-reuse",
            prose: "Operational procedure, not a topic for discussion. Define one reusable research procedure conceptually: for an input subject, use smart-search and verify its evidence. Discover and inspect smart-search once, then apply that same procedure to Alpha-1 and Beta-2. Verify both evidence IDs and answer only after both delivery tokens are available.",
            sexpr: "(process research-one (params subject) (seq (bind search-result (call skill_run (name smart-search) (input subject))) (call evidence_verify (evidence_id search-result.evidence_id))))\n\n(seq (bind capabilities (call skills_list)) (bind skill-spec (call skill_view (name smart-search))) (bind alpha-result (research-one Alpha-1)) (bind beta-result (research-one Beta-2)) (reply (tokens alpha-result.delivery_token beta-result.delivery_token)))",
            expected_tools: &["skills_list", "skill_view:smart-search", "skill_run:smart-search:Alpha-1", "evidence_verify:E-ALPHA", "skill_run:smart-search:Beta-2", "evidence_verify:E-BETA"],
            dependencies: &[
                ("skills_list", "skill_view:smart-search"),
                ("skill_view:smart-search", "skill_run:smart-search:Alpha-1"),
                ("skill_run:smart-search:Alpha-1", "evidence_verify:E-ALPHA"),
                ("skill_view:smart-search", "skill_run:smart-search:Beta-2"),
                ("skill_run:smart-search:Beta-2", "evidence_verify:E-BETA"),
            ],
            forbidden_tools: &[],
            final_tokens: &["ALPHA-VERIFIED", "BETA-VERIFIED"],
        },
        EvalTask {
            id: "guard-no-action",
            prose: "Operational procedure, not a topic for discussion. The supplied record is explicitly archival and does not require live freshness. If freshness is live, discover and run a skill. Otherwise call no tools and answer directly with ARCHIVE-DIRECT. The current freshness is archival.",
            sexpr: "(bind input (record (kind archived) (freshness archival)))\n\n(if (= input.freshness live) (seq (call skills_list) (call skill_run)) (reply ARCHIVE-DIRECT))",
            expected_tools: &[],
            dependencies: &[],
            forbidden_tools: &["skills_list", "skill_view", "skill_run", "evidence_verify"],
            final_tokens: &["ARCHIVE-DIRECT"],
        },
    ]
}

fn tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "skills_list".to_string(),
            description: "List compact deterministic skill capability signatures.".to_string(),
            parameters: json!({"type":"object","properties":{}}),
        },
        ToolDefinition {
            name: "skill_view".to_string(),
            description: "Load the operational content of one skill before using it.".to_string(),
            parameters: json!({
                "type":"object",
                "properties":{"name":{"type":"string"}},
                "required":["name"]
            }),
        },
        ToolDefinition {
            name: "skill_run".to_string(),
            description: "Apply a loaded skill to an input. Tool output is authoritative for success or failure.".to_string(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "name":{"type":"string"},
                    "input":{"type":"string"}
                },
                "required":["name","input"]
            }),
        },
        ToolDefinition {
            name: "evidence_verify".to_string(),
            description: "Verify one evidence ID and return its delivery token.".to_string(),
            parameters: json!({
                "type":"object",
                "properties":{"evidence_id":{"type":"string"}},
                "required":["evidence_id"]
            }),
        },
    ]
}

fn execute_tool(name: &str, arguments: &Value) -> Value {
    match name {
        "skills_list" => json!({
            "skills": [
                {"name":"local-file-search","cap":"find local static code","effects":"local-read"},
                {"name":"smart-search","cap":"find web live news zh","effects":"network-read"},
                {"name":"browser-research","cap":"find web live fallback","effects":"browser-read"}
            ]
        }),
        "skill_view" => match arguments.get("name").and_then(Value::as_str) {
            Some("smart-search") => json!({
                "name":"smart-search",
                "procedure":"Call skill_run(name=smart-search,input=<subject>). If it returns AUTH_REQUIRED, use an available fallback skill. Verify successful evidence before replying."
            }),
            Some("browser-research") => json!({
                "name":"browser-research",
                "procedure":"Call skill_run(name=browser-research,input=<subject>), then verify successful evidence before replying."
            }),
            Some(other) => json!({"error":"UNKNOWN_SKILL","name":other}),
            None => json!({"error":"MISSING_NAME"}),
        },
        "skill_run" => {
            let skill = arguments.get("name").and_then(Value::as_str).unwrap_or("");
            let input = arguments.get("input").and_then(Value::as_str).unwrap_or("");
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
        "evidence_verify" => match arguments.get("evidence_id").and_then(Value::as_str) {
            Some("E-NOVA") => json!({"verified":true,"delivery_token":"NOVA-VERIFIED"}),
            Some("E-ORION") => json!({"verified":true,"delivery_token":"ORION-VERIFIED"}),
            Some("E-ALPHA") => json!({"verified":true,"delivery_token":"ALPHA-VERIFIED"}),
            Some("E-BETA") => json!({"verified":true,"delivery_token":"BETA-VERIFIED"}),
            Some(other) => json!({"verified":false,"error":"UNKNOWN_EVIDENCE","evidence_id":other}),
            None => json!({"verified":false,"error":"MISSING_EVIDENCE_ID"}),
        },
        other => json!({"error":"UNKNOWN_TOOL","name":other}),
    }
}

fn score_episode(task: &EvalTask, trace: &[ToolTrace], final_answer: &str) -> Vec<CriterionResult> {
    let actual = trace.iter().map(trace_key).collect::<Vec<_>>();
    let mut criteria = Vec::new();
    let mut cursor = 0usize;
    let mut missing = Vec::new();
    for expected in task.expected_tools {
        if let Some(offset) = actual[cursor..]
            .iter()
            .position(|actual| actual == expected)
        {
            cursor += offset + 1;
        } else {
            missing.push((*expected).to_string());
        }
    }
    criteria.push(CriterionResult {
        id: "required-tool-order".to_string(),
        passed: missing.is_empty(),
        evidence: if missing.is_empty() {
            format!("actual={actual:?}")
        } else {
            format!("missing={missing:?}; actual={actual:?}")
        },
    });
    let expected = task
        .expected_tools
        .iter()
        .map(|entry| (*entry).to_string())
        .collect::<Vec<_>>();
    criteria.push(CriterionResult {
        id: "exact-tool-plan".to_string(),
        passed: actual == expected,
        evidence: format!("expected={expected:?}; actual={actual:?}"),
    });
    let violated_dependencies = task
        .dependencies
        .iter()
        .filter_map(|(before, after)| {
            let before_attempt = trace
                .iter()
                .find(|entry| trace_key(entry) == *before)
                .map(|entry| entry.attempt);
            let after_attempt = trace
                .iter()
                .find(|entry| trace_key(entry) == *after)
                .map(|entry| entry.attempt);
            match (before_attempt, after_attempt) {
                (Some(left), Some(right)) if left < right => None,
                _ => Some(format!(
                    "{before} -> {after}: {before_attempt:?} -> {after_attempt:?}"
                )),
            }
        })
        .collect::<Vec<_>>();
    criteria.push(CriterionResult {
        id: "causal-rounds".to_string(),
        passed: violated_dependencies.is_empty(),
        evidence: format!("violations={violated_dependencies:?}"),
    });
    let forbidden = trace
        .iter()
        .filter(|entry| task.forbidden_tools.contains(&entry.name.as_str()))
        .map(|entry| entry.name.clone())
        .collect::<Vec<_>>();
    criteria.push(CriterionResult {
        id: "branch-discipline".to_string(),
        passed: forbidden.is_empty(),
        evidence: format!("forbidden_calls={forbidden:?}"),
    });
    let missing_tokens = task
        .final_tokens
        .iter()
        .filter(|token| !contains_standalone_token(final_answer, token))
        .copied()
        .collect::<Vec<_>>();
    criteria.push(CriterionResult {
        id: "final-delivery".to_string(),
        passed: missing_tokens.is_empty(),
        evidence: format!("missing_tokens={missing_tokens:?}; final={final_answer:?}"),
    });
    criteria
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

fn trace_key(trace: &ToolTrace) -> String {
    match trace.name.as_str() {
        "skill_view" => format!(
            "skill_view:{}",
            trace
                .arguments
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
        ),
        "skill_run" => format!(
            "skill_run:{}:{}",
            trace
                .arguments
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(""),
            trace
                .arguments
                .get("input")
                .and_then(Value::as_str)
                .unwrap_or("")
        ),
        "evidence_verify" => format!(
            "evidence_verify:{}",
            trace
                .arguments
                .get("evidence_id")
                .and_then(Value::as_str)
                .unwrap_or("")
        ),
        other => other.to_string(),
    }
}

fn summarize(episodes: &[EpisodeReport]) -> BTreeMap<String, ArmSummary> {
    let mut summaries = BTreeMap::new();
    for arm in Arm::ALL {
        let selected = episodes
            .iter()
            .filter(|episode| episode.arm == arm.name())
            .collect::<Vec<_>>();
        let count = selected.len();
        let passed = selected.iter().filter(|episode| episode.success).count();
        let semantic_passed = selected
            .iter()
            .filter(|episode| episode.semantic_success)
            .count();
        let denominator = count.max(1) as f64;
        summaries.insert(
            arm.name().to_string(),
            ArmSummary {
                episodes: count,
                passed,
                pass_rate: passed as f64 / denominator,
                semantic_passed,
                semantic_pass_rate: semantic_passed as f64 / denominator,
                mean_score: selected
                    .iter()
                    .map(|episode| episode.score as f64)
                    .sum::<f64>()
                    / denominator,
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
    fn ablation_uses_five_pre_registered_arms() {
        assert_eq!(Arm::ALL.len(), 5);
        assert_eq!(Arm::AnnotatedKernel.system_prompt(), ANNOTATED_KERNEL);
        assert!(Arm::AnnotatedKernel
            .system_prompt()
            .starts_with("(vm morphz"));
        assert!(Arm::AnnotatedKernel
            .system_prompt()
            .contains("先完整求值 expression"));
        assert_eq!(Arm::BareReadable.task_prompt(&tasks()[0]), tasks()[0].sexpr);
    }

    #[test]
    fn deterministic_tools_expose_fallback_and_verification() {
        assert_eq!(
            execute_tool(
                "skill_run",
                &json!({"name":"smart-search","input":"Orion-9"})
            )["error"],
            "AUTH_REQUIRED"
        );
        assert_eq!(
            execute_tool(
                "skill_run",
                &json!({"name":"browser-research","input":"Orion-9"})
            )["evidence_id"],
            "E-ORION"
        );
        assert_eq!(
            execute_tool("evidence_verify", &json!({"evidence_id":"E-ORION"}))["delivery_token"],
            "ORION-VERIFIED"
        );
    }

    #[test]
    fn scoring_requires_order_branch_and_delivery() {
        let task = tasks().remove(0);
        let names = [
            ("skills_list", json!({})),
            ("skill_view", json!({"name":"smart-search"})),
            ("skill_run", json!({"name":"smart-search","input":"Nova-7"})),
            ("evidence_verify", json!({"evidence_id":"E-NOVA"})),
        ];
        let trace = names
            .into_iter()
            .enumerate()
            .map(|(index, (name, arguments))| ToolTrace {
                attempt: index + 1,
                name: name.to_string(),
                arguments,
                output: json!({}),
            })
            .collect::<Vec<_>>();
        assert!(score_episode(&task, &trace, "NOVA-VERIFIED")
            .iter()
            .all(|criterion| criterion.passed));
    }

    #[test]
    fn scoring_rejects_calls_that_guess_unseen_dependencies() {
        let task = tasks().remove(0);
        let trace = [
            ("skills_list", json!({})),
            ("skill_view", json!({"name":"smart-search"})),
            ("skill_run", json!({"name":"smart-search","input":"Nova-7"})),
            ("evidence_verify", json!({"evidence_id":"E-NOVA"})),
        ]
        .into_iter()
        .map(|(name, arguments)| ToolTrace {
            attempt: 1,
            name: name.to_string(),
            arguments,
            output: json!({}),
        })
        .collect::<Vec<_>>();
        let criteria = score_episode(&task, &trace, "NOVA-VERIFIED");
        assert!(
            !criteria
                .iter()
                .find(|criterion| criterion.id == "causal-rounds")
                .expect("causal-rounds criterion")
                .passed
        );
    }

    #[test]
    fn delivery_token_matching_rejects_prefixed_hallucinations() {
        assert!(contains_standalone_token(
            "Delivery: **NOVA-VERIFIED**",
            "NOVA-VERIFIED"
        ));
        assert!(!contains_standalone_token(
            "T-NOVA-VERIFIED",
            "NOVA-VERIFIED"
        ));
        assert!(!contains_standalone_token(
            "NOVA-VERIFIED-EXTRA",
            "NOVA-VERIFIED"
        ));
    }

    #[test]
    fn scoring_rejects_extra_recovery_calls_as_an_unclean_plan() {
        let task = tasks().remove(0);
        let trace = [
            (1, "skills_list", json!({})),
            (2, "skill_view", json!({"name":"smart-search"})),
            (3, "skill_run", json!({"name":"smart-","input":"Nova-7"})),
            (
                4,
                "skill_run",
                json!({"name":"smart-search","input":"Nova-7"}),
            ),
            (5, "evidence_verify", json!({"evidence_id":"E-NOVA"})),
        ]
        .into_iter()
        .map(|(attempt, name, arguments)| ToolTrace {
            attempt,
            name: name.to_string(),
            arguments,
            output: json!({}),
        })
        .collect::<Vec<_>>();
        let criteria = score_episode(&task, &trace, "NOVA-VERIFIED");
        assert!(
            !criteria
                .iter()
                .find(|criterion| criterion.id == "exact-tool-plan")
                .expect("exact-tool-plan criterion")
                .passed
        );
    }
}
