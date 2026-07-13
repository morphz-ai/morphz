use crate::config::{self, AppConfig};
use crate::llm::{Client, FunctionCall, Message, OpenAIClient, ToolCall, ToolDefinition};
use crate::sexpr_vm_contract::ANNOTATED_KERNEL;
use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

type DynError = Box<dyn std::error::Error + Send + Sync>;

const MAX_ATTEMPTS: usize = 16;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum Arm {
    AnnotatedKernel,
    BareReadable,
}

impl Arm {
    const ALL: [Self; 2] = [Self::AnnotatedKernel, Self::BareReadable];

    fn name(self) -> &'static str {
        match self {
            Self::AnnotatedKernel => "annotated_kernel",
            Self::BareReadable => "bare_readable",
        }
    }

    fn system_prompt(self) -> &'static str {
        match self {
            Self::AnnotatedKernel => ANNOTATED_KERNEL,
            Self::BareReadable => "You are a tool-using agent.",
        }
    }
}

#[derive(Clone)]
struct EvalTask {
    id: &'static str,
    sexpr: &'static str,
    expected_tools: &'static [&'static str],
    dependencies: &'static [(&'static str, &'static str)],
    final_token: &'static str,
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
    pub dataflow_success: bool,
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
    pub dataflow_passed: usize,
    pub dataflow_pass_rate: f64,
    pub mean_attempts: f64,
    pub mean_tool_calls: f64,
}

#[derive(Debug, Serialize)]
pub struct BindIfEvalReport {
    pub id: String,
    pub created_at: String,
    pub model: String,
    pub repetitions: usize,
    pub output_dir: PathBuf,
    pub summaries: BTreeMap<String, ArmSummary>,
    pub episodes: Vec<EpisodeReport>,
    pub conclusion_boundary: String,
}

pub async fn run_bind_if_eval(
    output_base: &Path,
    repetitions: usize,
) -> Result<BindIfEvalReport, DynError> {
    if repetitions == 0 {
        return Err("repetitions 必须大于 0".into());
    }
    let _ = config::load_env(".env");
    let api_key = std::env::var("OPENAI_API_KEY")?;
    let base_url = std::env::var("OPENAI_BASE_URL").unwrap_or_default();
    let app_config = AppConfig::load_or_default("morphz.toml");
    let model = std::env::var("OPENAI_MODEL").unwrap_or_else(|_| app_config.llm.model.clone());
    let client =
        OpenAIClient::new_with_config(api_key, base_url, model.clone(), None, &app_config.llm)?;
    let id = format!(
        "sexpr-bind-if-eval-v1-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    );
    let output_dir = output_base.join(&id);
    std::fs::create_dir_all(&output_dir)?;

    let mut episodes = Vec::new();
    for run in 1..=repetitions {
        for task in tasks() {
            let arms = if run % 2 == 1 {
                Arm::ALL
            } else {
                [Arm::BareReadable, Arm::AnnotatedKernel]
            };
            for arm in arms {
                let episode = run_episode(&client, run, arm, &task).await;
                std::fs::write(
                    output_dir.join(format!("run-{run}-{}-{}.json", task.id, arm.name())),
                    serde_json::to_vec_pretty(&episode)?,
                )?;
                episodes.push(episode);
            }
        }
    }

    let report = BindIfEvalReport {
        id,
        created_at: Utc::now().to_rfc3339(),
        model,
        repetitions,
        output_dir: output_dir.clone(),
        summaries: summarize(&episodes),
        episodes,
        conclusion_boundary: "该基准只测试模型自行解释 bind/if 时的精确引用、局部作用域和单分支执行；Runtime 不解析变量、不替模型选择分支。确定性工具隔离了外部网络和真实业务质量。".to_string(),
    };
    std::fs::write(
        output_dir.join("report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(report)
}

async fn run_episode(client: &dyn Client, run: usize, arm: Arm, task: &EvalTask) -> EpisodeReport {
    let mut messages = vec![
        message("system", arm.system_prompt()),
        message("user", task.sexpr),
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

    let criteria = score_episode(task, &trace, &final_answer);
    let score = criteria.iter().filter(|criterion| criterion.passed).count() as u32;
    let max_score = criteria.len() as u32;
    let semantic_success = criteria
        .iter()
        .filter(|criterion| criterion.id != "exact-tool-plan")
        .all(|criterion| criterion.passed);
    let dataflow_success = criteria
        .iter()
        .filter(|criterion| {
            matches!(
                criterion.id.as_str(),
                "reference-and-branch-accuracy" | "causal-dataflow"
            )
        })
        .all(|criterion| criterion.passed);
    EpisodeReport {
        run,
        arm: arm.name().to_string(),
        task: task.id.to_string(),
        success: score == max_score,
        semantic_success,
        dataflow_success,
        score,
        max_score,
        attempts,
        system_prompt_chars: arm.system_prompt().chars().count(),
        task_prompt_chars: task.sexpr.chars().count(),
        tool_trace: trace,
        final_answer,
        error: episode_error,
        criteria,
    }
}

fn tasks() -> Vec<EvalTask> {
    vec![
        EvalTask {
            id: "binding-chain",
            sexpr: r#"(seq
  (bind value-a (call make_value (name A)))
  (bind value-b (call make_value (name B) (parent value-a.token)))
  (bind value-c (call make_value (name C) (parent value-b.token)))
  (bind value-d (call make_value (name D) (parent value-c.token)))
  (bind verification
    (call verify_chain
      (first value-a.token)
      (middle value-c.token)
      (last value-d.token)))
  (reply verification.delivery_token))"#,
            expected_tools: &[
                "make_value:A:",
                "make_value:B:T-A-7319",
                "make_value:C:T-B-1847",
                "make_value:D:T-C-9026",
                "verify_chain:T-A-7319:T-C-9026:T-D-4651",
            ],
            dependencies: &[
                ("make_value:A:", "make_value:B:T-A-7319"),
                ("make_value:B:T-A-7319", "make_value:C:T-B-1847"),
                ("make_value:C:T-B-1847", "make_value:D:T-C-9026"),
                (
                    "make_value:D:T-C-9026",
                    "verify_chain:T-A-7319:T-C-9026:T-D-4651",
                ),
            ],
            final_token: "CHAIN-VERIFIED",
        },
        EvalTask {
            id: "repeated-local-scope",
            sexpr: r#"(process confirm-one
  (params subject)
  (seq
    (bind observed
      (call lookup_subject (subject subject)))
    (if observed.ok
      (call confirm_subject
        (subject subject)
        (token observed.token))
      observed)))

(seq
  (bind alpha-result (confirm-one Alpha-1))
  (bind beta-result (confirm-one Beta-2))
  (bind gamma-result (confirm-one Gamma-3))
  (bind verification
    (call verify_scope
      (alpha alpha-result.receipt)
      (beta beta-result.receipt)
      (gamma gamma-result.receipt)))
  (reply verification.delivery_token))"#,
            expected_tools: &[
                "lookup_subject:Alpha-1",
                "confirm_subject:Alpha-1:S-ALPHA-7319",
                "lookup_subject:Beta-2",
                "confirm_subject:Beta-2:S-BETA-7139",
                "lookup_subject:Gamma-3",
                "confirm_subject:Gamma-3:S-GAMMA-7391",
                "verify_scope:R-ALPHA:R-BETA:R-GAMMA",
            ],
            dependencies: &[
                (
                    "lookup_subject:Alpha-1",
                    "confirm_subject:Alpha-1:S-ALPHA-7319",
                ),
                (
                    "lookup_subject:Beta-2",
                    "confirm_subject:Beta-2:S-BETA-7139",
                ),
                (
                    "lookup_subject:Gamma-3",
                    "confirm_subject:Gamma-3:S-GAMMA-7391",
                ),
                (
                    "confirm_subject:Alpha-1:S-ALPHA-7319",
                    "verify_scope:R-ALPHA:R-BETA:R-GAMMA",
                ),
                (
                    "confirm_subject:Beta-2:S-BETA-7139",
                    "verify_scope:R-ALPHA:R-BETA:R-GAMMA",
                ),
                (
                    "confirm_subject:Gamma-3:S-GAMMA-7391",
                    "verify_scope:R-ALPHA:R-BETA:R-GAMMA",
                ),
            ],
            final_token: "SCOPE-VERIFIED",
        },
        EvalTask {
            id: "alternating-if-branches",
            sexpr: r#"(seq
  (bind case-one (call read_case (case C1)))
  (bind route-one
    (if case-one.enabled
      (call route_true (case C1) (token case-one.token))
      (call route_false (case C1) (token case-one.token))))

  (bind case-two (call read_case (case C2)))
  (bind route-two
    (if case-two.enabled
      (call route_true (case C2) (token case-two.token))
      (call route_false (case C2) (token case-two.token))))

  (bind case-three (call read_case (case C3)))
  (bind route-three
    (if case-three.enabled
      (call route_true (case C3) (token case-three.token))
      (call route_false (case C3) (token case-three.token))))

  (bind case-four (call read_case (case C4)))
  (bind route-four
    (if case-four.enabled
      (call route_true (case C4) (token case-four.token))
      (call route_false (case C4) (token case-four.token))))

  (bind verification
    (call verify_routes
      (one route-one.receipt)
      (two route-two.receipt)
      (three route-three.receipt)
      (four route-four.receipt)))
  (reply verification.delivery_token))"#,
            expected_tools: &[
                "read_case:C1",
                "route_true:C1:Q-C1-8264",
                "read_case:C2",
                "route_false:C2:Q-C2-2684",
                "read_case:C3",
                "route_true:C3:Q-C3-8426",
                "read_case:C4",
                "route_false:C4:Q-C4-2846",
                "verify_routes:RT-C1:RF-C2:RT-C3:RF-C4",
            ],
            dependencies: &[
                ("read_case:C1", "route_true:C1:Q-C1-8264"),
                ("read_case:C2", "route_false:C2:Q-C2-2684"),
                ("read_case:C3", "route_true:C3:Q-C3-8426"),
                ("read_case:C4", "route_false:C4:Q-C4-2846"),
                (
                    "route_true:C1:Q-C1-8264",
                    "verify_routes:RT-C1:RF-C2:RT-C3:RF-C4",
                ),
                (
                    "route_false:C2:Q-C2-2684",
                    "verify_routes:RT-C1:RF-C2:RT-C3:RF-C4",
                ),
                (
                    "route_true:C3:Q-C3-8426",
                    "verify_routes:RT-C1:RF-C2:RT-C3:RF-C4",
                ),
                (
                    "route_false:C4:Q-C4-2846",
                    "verify_routes:RT-C1:RF-C2:RT-C3:RF-C4",
                ),
            ],
            final_token: "ROUTES-VERIFIED",
        },
    ]
}

fn tool_definitions() -> Vec<ToolDefinition> {
    vec![
        tool(
            "make_value",
            "Create one opaque value. Parent must match the prior returned token when required.",
            json!({"type":"object","properties":{"name":{"type":"string"},"parent":{"type":"string"}},"required":["name"]}),
        ),
        tool(
            "verify_chain",
            "Verify exact values from several earlier bindings.",
            json!({"type":"object","properties":{"first":{"type":"string"},"middle":{"type":"string"},"last":{"type":"string"}},"required":["first","middle","last"]}),
        ),
        tool(
            "lookup_subject",
            "Return an opaque subject token.",
            json!({"type":"object","properties":{"subject":{"type":"string"}},"required":["subject"]}),
        ),
        tool(
            "confirm_subject",
            "Confirm that a token belongs to the named subject.",
            json!({"type":"object","properties":{"subject":{"type":"string"},"token":{"type":"string"}},"required":["subject","token"]}),
        ),
        tool(
            "verify_scope",
            "Verify receipts from three independent process invocations.",
            json!({"type":"object","properties":{"alpha":{"type":"string"},"beta":{"type":"string"},"gamma":{"type":"string"}},"required":["alpha","beta","gamma"]}),
        ),
        tool(
            "read_case",
            "Return an opaque token and a boolean routing flag.",
            json!({"type":"object","properties":{"case":{"type":"string"}},"required":["case"]}),
        ),
        tool(
            "route_true",
            "Handle a case only when its observed enabled flag is true.",
            json!({"type":"object","properties":{"case":{"type":"string"},"token":{"type":"string"}},"required":["case","token"]}),
        ),
        tool(
            "route_false",
            "Handle a case only when its observed enabled flag is false.",
            json!({"type":"object","properties":{"case":{"type":"string"},"token":{"type":"string"}},"required":["case","token"]}),
        ),
        tool(
            "verify_routes",
            "Verify receipts from four conditionally selected branches.",
            json!({"type":"object","properties":{"one":{"type":"string"},"two":{"type":"string"},"three":{"type":"string"},"four":{"type":"string"}},"required":["one","two","three","four"]}),
        ),
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
        "make_value" => make_value(arguments),
        "verify_chain" => {
            let valid = string(arguments, "first") == "T-A-7319"
                && string(arguments, "middle") == "T-C-9026"
                && string(arguments, "last") == "T-D-4651";
            result(valid, "CHAIN-VERIFIED", "CHAIN_MISMATCH")
        }
        "lookup_subject" => match string(arguments, "subject") {
            "Alpha-1" => json!({"ok":true,"subject":"Alpha-1","token":"S-ALPHA-7319"}),
            "Beta-2" => json!({"ok":true,"subject":"Beta-2","token":"S-BETA-7139"}),
            "Gamma-3" => json!({"ok":true,"subject":"Gamma-3","token":"S-GAMMA-7391"}),
            subject => json!({"ok":false,"error":"UNKNOWN_SUBJECT","subject":subject}),
        },
        "confirm_subject" => confirm_subject(arguments),
        "verify_scope" => {
            let valid = string(arguments, "alpha") == "R-ALPHA"
                && string(arguments, "beta") == "R-BETA"
                && string(arguments, "gamma") == "R-GAMMA";
            result(valid, "SCOPE-VERIFIED", "SCOPE_MISMATCH")
        }
        "read_case" => match string(arguments, "case") {
            "C1" => json!({"ok":true,"enabled":true,"token":"Q-C1-8264"}),
            "C2" => json!({"ok":true,"enabled":false,"token":"Q-C2-2684"}),
            "C3" => json!({"ok":true,"enabled":true,"token":"Q-C3-8426"}),
            "C4" => json!({"ok":true,"enabled":false,"token":"Q-C4-2846"}),
            value => json!({"ok":false,"error":"UNKNOWN_CASE","case":value}),
        },
        "route_true" => route(arguments, true),
        "route_false" => route(arguments, false),
        "verify_routes" => {
            let valid = string(arguments, "one") == "RT-C1"
                && string(arguments, "two") == "RF-C2"
                && string(arguments, "three") == "RT-C3"
                && string(arguments, "four") == "RF-C4";
            result(valid, "ROUTES-VERIFIED", "ROUTES_MISMATCH")
        }
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
        json!({"ok":false,"error":"PARENT_MISMATCH","expected_parent":expected_parent})
    }
}

fn confirm_subject(arguments: &Value) -> Value {
    let subject = string(arguments, "subject");
    let token = string(arguments, "token");
    let (expected, receipt) = match subject {
        "Alpha-1" => ("S-ALPHA-7319", "R-ALPHA"),
        "Beta-2" => ("S-BETA-7139", "R-BETA"),
        "Gamma-3" => ("S-GAMMA-7391", "R-GAMMA"),
        _ => return json!({"ok":false,"error":"UNKNOWN_SUBJECT"}),
    };
    if token == expected {
        json!({"ok":true,"receipt":receipt})
    } else {
        json!({"ok":false,"error":"TOKEN_MISMATCH","expected":expected})
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
        json!({"ok":false,"error":"WRONG_BRANCH_OR_TOKEN"})
    }
}

fn result(valid: bool, delivery_token: &str, error: &str) -> Value {
    if valid {
        json!({"ok":true,"delivery_token":delivery_token})
    } else {
        json!({"ok":false,"error":error})
    }
}

fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn score_episode(task: &EvalTask, trace: &[ToolTrace], final_answer: &str) -> Vec<CriterionResult> {
    let actual = trace.iter().map(trace_key).collect::<Vec<_>>();
    let expected = task
        .expected_tools
        .iter()
        .map(|value| (*value).to_string())
        .collect::<Vec<_>>();
    let mut actual_multiset = actual.clone();
    let mut expected_multiset = expected.clone();
    actual_multiset.sort();
    expected_multiset.sort();

    let attempts_by_key = trace
        .iter()
        .map(|entry| (trace_key(entry), entry.attempt))
        .collect::<BTreeMap<_, _>>();
    let dependency_violations = task
        .dependencies
        .iter()
        .filter_map(|(producer, consumer)| {
            let producer_attempt = attempts_by_key.get(*producer);
            let consumer_attempt = attempts_by_key.get(*consumer);
            match (producer_attempt, consumer_attempt) {
                (Some(producer_attempt), Some(consumer_attempt))
                    if producer_attempt < consumer_attempt =>
                {
                    None
                }
                _ => Some(format!(
                    "{producer}@{producer_attempt:?} !< {consumer}@{consumer_attempt:?}"
                )),
            }
        })
        .collect::<Vec<_>>();
    let strict_seq = trace
        .windows(2)
        .all(|pair| pair[0].attempt < pair[1].attempt);
    vec![
        CriterionResult {
            id: "reference-and-branch-accuracy".to_string(),
            passed: actual_multiset == expected_multiset,
            evidence: format!(
                "expected_multiset={expected_multiset:?}; actual_multiset={actual_multiset:?}"
            ),
        },
        CriterionResult {
            id: "causal-dataflow".to_string(),
            passed: dependency_violations.is_empty(),
            evidence: format!("violations={dependency_violations:?}"),
        },
        CriterionResult {
            id: "exact-tool-plan".to_string(),
            passed: actual == expected,
            evidence: format!("expected={expected:?}; actual={actual:?}"),
        },
        CriterionResult {
            id: "strict-seq-rounds".to_string(),
            passed: strict_seq,
            evidence: format!(
                "attempts={:?}",
                trace.iter().map(|entry| entry.attempt).collect::<Vec<_>>()
            ),
        },
        CriterionResult {
            id: "final-delivery".to_string(),
            passed: contains_standalone_token(final_answer, task.final_token),
            evidence: format!("expected={:?}; final={final_answer:?}", task.final_token),
        },
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
        "lookup_subject" => format!("lookup_subject:{}", string(&trace.arguments, "subject")),
        "confirm_subject" => format!(
            "confirm_subject:{}:{}",
            string(&trace.arguments, "subject"),
            string(&trace.arguments, "token")
        ),
        "verify_scope" => format!(
            "verify_scope:{}:{}:{}",
            string(&trace.arguments, "alpha"),
            string(&trace.arguments, "beta"),
            string(&trace.arguments, "gamma")
        ),
        "read_case" => format!("read_case:{}", string(&trace.arguments, "case")),
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
    let mut summaries = BTreeMap::new();
    for arm in Arm::ALL {
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
        let dataflow_passed = selected
            .iter()
            .filter(|episode| episode.dataflow_success)
            .count();
        summaries.insert(
            arm.name().to_string(),
            ArmSummary {
                episodes: count,
                passed,
                pass_rate: passed as f64 / denominator,
                semantic_passed,
                semantic_pass_rate: semantic_passed as f64 / denominator,
                dataflow_passed,
                dataflow_pass_rate: dataflow_passed as f64 / denominator,
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
    fn chain_fixture_requires_prior_exact_value() {
        assert_eq!(
            make_value(&json!({"name":"B","parent":"wrong"}))["error"],
            "PARENT_MISMATCH"
        );
        assert_eq!(
            make_value(&json!({"name":"B","parent":"T-A-7319"}))["token"],
            "T-B-1847"
        );
    }

    #[test]
    fn branch_fixture_rejects_wrong_branch() {
        assert_eq!(
            route(&json!({"case":"C2","token":"Q-C2-2684"}), true)["error"],
            "WRONG_BRANCH_OR_TOKEN"
        );
        assert_eq!(
            route(&json!({"case":"C2","token":"Q-C2-2684"}), false)["receipt"],
            "RF-C2"
        );
    }

    #[test]
    fn scorer_requires_exact_values_and_separate_rounds() {
        let task = tasks().remove(0);
        let trace = vec![ToolTrace {
            attempt: 1,
            name: "make_value".to_string(),
            arguments: json!({"name":"A"}),
            output: json!({}),
        }];
        let criteria = score_episode(&task, &trace, "CHAIN-VERIFIED");
        assert!(!criteria.iter().all(|criterion| criterion.passed));
    }

    #[test]
    fn scorer_separates_valid_parallel_dataflow_from_strict_seq() {
        let task = tasks().remove(1);
        let trace = vec![
            test_trace(1, "lookup_subject", json!({"subject":"Alpha-1"})),
            test_trace(1, "lookup_subject", json!({"subject":"Beta-2"})),
            test_trace(1, "lookup_subject", json!({"subject":"Gamma-3"})),
            test_trace(
                2,
                "confirm_subject",
                json!({"subject":"Alpha-1","token":"S-ALPHA-7319"}),
            ),
            test_trace(
                2,
                "confirm_subject",
                json!({"subject":"Beta-2","token":"S-BETA-7139"}),
            ),
            test_trace(
                2,
                "confirm_subject",
                json!({"subject":"Gamma-3","token":"S-GAMMA-7391"}),
            ),
            test_trace(
                3,
                "verify_scope",
                json!({"alpha":"R-ALPHA","beta":"R-BETA","gamma":"R-GAMMA"}),
            ),
        ];
        let criteria = score_episode(&task, &trace, "SCOPE-VERIFIED");
        assert!(criterion(&criteria, "reference-and-branch-accuracy"));
        assert!(criterion(&criteria, "causal-dataflow"));
        assert!(!criterion(&criteria, "strict-seq-rounds"));
        assert!(!criterion(&criteria, "exact-tool-plan"));
    }

    fn test_trace(attempt: usize, name: &str, arguments: Value) -> ToolTrace {
        ToolTrace {
            attempt,
            name: name.to_string(),
            arguments,
            output: json!({}),
        }
    }

    fn criterion(criteria: &[CriterionResult], id: &str) -> bool {
        criteria
            .iter()
            .find(|criterion| criterion.id == id)
            .is_some_and(|criterion| criterion.passed)
    }
}
