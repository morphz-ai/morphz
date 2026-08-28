//! Real-model evaluation of the Yao program surface.
//!
//! What is measured is model capability against the language, in isolation:
//! can a real model, given only the `eval` tool description, write a valid
//! program on the first try; when the validator refuses one, does the repair
//! feedback actually lead it to a valid resubmission; and does it reach for
//! `eval` at all when a task is shaped for it. The production wiring —
//! Orchestrator interception, budgets, and durable Event persistence — is integration-tested with
//! mocks and deliberately out of scope here, exactly as the bind/if benchmark
//! isolates the model's own evaluation semantics.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::Utc;
use morphz::llm::{Client, FunctionCall, Message, ToolCall};
use morphz::permission::PermissionConfig;
use morphz::sexpr_eval::{
    EvalTool, RuntimeInference, CURRENT_INFERENCE, DEFAULT_CALLABLE_TOOLS, MAX_INFER_ROUNDS,
};
use morphz::tool::{ListFilesTool, ReadFileTool, Registry, SearchTool};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};

type DynError = Box<dyn std::error::Error + Send + Sync>;

const MAX_TURNS: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgramAttempt {
    pub turn: usize,
    pub source: String,
    pub valid: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CriterionResult {
    pub id: String,
    pub passed: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpisodeReport {
    pub run: usize,
    pub task: String,
    pub used_eval: bool,
    pub first_program_valid: Option<bool>,
    pub repaired_after_feedback: Option<bool>,
    pub programs: Vec<ProgramAttempt>,
    pub infer_requests: usize,
    pub model_requests: usize,
    pub direct_tool_calls: usize,
    pub answer_correct: bool,
    pub success: bool,
    pub criteria: Vec<CriterionResult>,
    pub final_answer: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSummary {
    pub task: String,
    pub episodes: usize,
    pub eval_adoption: usize,
    pub first_try_valid: usize,
    pub repaired: usize,
    pub answer_correct: usize,
    pub success: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YaoProgramEvalReport {
    pub id: String,
    pub created_at: String,
    pub model: String,
    pub repetitions: usize,
    pub output_dir: PathBuf,
    pub summaries: Vec<TaskSummary>,
    pub episodes: Vec<EpisodeReport>,
    pub conclusion_boundary: String,
}

struct EvalTask {
    id: &'static str,
    prompt: &'static str,
}

fn tasks() -> Vec<EvalTask> {
    vec![
        EvalTask {
            id: "todo-fanout",
            prompt: "找出 src 目录下所有包含 TODO 的 .rs 文件，报告这些文件名。",
        },
        EvalTask {
            id: "pointer-chase",
            prompt: "工作区里有一个 pointer.txt，内容是另一个文件的文件名。\
                     请读出它指向的那个文件里的口令并报告。",
        },
        EvalTask {
            id: "infer-classify",
            prompt: "读取 notes.txt，判断其中记录的问题属于哪一类（性能/安全/正确性），\
                     并提取一个最能代表该问题的检索关键词；用这个关键词在 docs 目录下检索，\
                     报告类别和命中的文件。",
        },
        EvalTask {
            id: "declared-tools",
            prompt:
                "只使用 read 和 list_files 两个工具，完成：列出 src 目录内容并读取其中的 alpha.rs，\
                     报告它包含的 TODO 注释内容。",
        },
    ]
}

fn write_fixtures(root: &Path) -> Result<(), DynError> {
    std::fs::create_dir_all(root.join("src"))?;
    std::fs::create_dir_all(root.join("docs"))?;
    std::fs::write(
        root.join("src/alpha.rs"),
        "fn alpha() {}\n// TODO: optimize the hot path\n",
    )?;
    std::fs::write(root.join("src/beta.rs"), "fn beta() {}\n// clean file\n")?;
    std::fs::write(
        root.join("src/gamma.rs"),
        "fn gamma() {}\n// TODO: fix panic on empty input\n",
    )?;
    std::fs::write(root.join("pointer.txt"), "target-note.md")?;
    std::fs::write(root.join("target-note.md"), "口令是 MOONGATE-88。\n")?;
    std::fs::write(
        root.join("notes.txt"),
        "巡检记录：发现服务日志把用户密码明文打印了出来，存在凭据泄露风险，必须尽快修复。\n",
    )?;
    std::fs::write(
        root.join("docs/security-guide.md"),
        "安全基线：任何日志都不得包含明文凭据。密码、令牌一律脱敏。\n",
    )?;
    std::fs::write(
        root.join("docs/perf-guide.md"),
        "性能基线：热路径避免多余分配。\n",
    )?;
    Ok(())
}

fn sandbox_registry(root: &Path) -> Arc<Registry> {
    let permissions = Arc::new(PermissionConfig {
        workspace_root: root.to_string_lossy().to_string(),
        ..PermissionConfig::default()
    });
    let registry = Registry::new();
    registry.register(Arc::new(ReadFileTool::new(Arc::clone(&permissions))));
    registry.register(Arc::new(ListFilesTool::new(Arc::clone(&permissions))));
    registry.register(Arc::new(SearchTool::new(Arc::clone(&permissions))));
    let registry = Arc::new(registry);
    registry.register(Arc::new(EvalTool::with_default_tools(Arc::clone(
        &registry,
    ))));
    registry
}

/// Mirrors `OrchestratorInference` for a harness without an Orchestrator: the
/// same request shape, the same tool gate, the same "an answer without tool
/// calls is the value" termination.
struct DirectInference {
    client: Arc<dyn Client>,
    registry: Arc<Registry>,
    infer_requests: Arc<Mutex<usize>>,
}

#[async_trait::async_trait]
impl RuntimeInference for DirectInference {
    async fn infer(
        &self,
        request: &JsonMap<String, JsonValue>,
        declared: Option<&[String]>,
    ) -> Result<String, DynError> {
        let program = request
            .get("program")
            .and_then(|value| value.as_str())
            .ok_or("canonical infer request is missing complete Yao program")?;
        let captures = request
            .get("captures")
            .cloned()
            .unwrap_or_else(|| JsonValue::Object(JsonMap::new()));
        let definitions = request
            .get("type_definitions")
            .cloned()
            .unwrap_or_else(|| JsonValue::Object(JsonMap::new()));
        let mut messages = vec![Message {
            role: "user".to_string(),
            content: format!(
                "以下不是用户消息，而是你自己提交的 Yao 程序求值到 (infer ...) 时建立的正式模型求值。\
                 请对完整 BODY 求值；需要证据时可以调用静态允许的工具。直接给出的最终正文\
                 是该 infer 的候选值，会经过返回类型校验后交回父程序继续求值。\n\
                 显式捕获的父程序绑定：{}\n\
                 相关类型定义：{}\n\
                 完整 Yao 程序：\n{}",
                serde_json::to_string(&captures).unwrap_or_else(|_| "{}".to_string()),
                serde_json::to_string(&definitions).unwrap_or_else(|_| "{}".to_string()),
                program
            ),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        }];
        let tools = self
            .registry
            .definitions()
            .into_iter()
            .filter(|definition| DEFAULT_CALLABLE_TOOLS.contains(&definition.name.as_str()))
            .filter(|definition| {
                declared.is_none_or(|list| list.iter().any(|tool| tool == &definition.name))
            })
            .collect::<Vec<_>>();
        for round in 0..MAX_INFER_ROUNDS {
            *self.infer_requests.lock().unwrap() += 1;
            let response = self
                .client
                .create_completion(messages.clone(), tools.clone())
                .await?;
            if response.tool_calls.is_empty() {
                return Ok(response.content);
            }
            if round + 1 == MAX_INFER_ROUNDS {
                return Err(
                    format!("infer 连续 {MAX_INFER_ROUNDS} 轮只调用工具而没有给出值").into(),
                );
            }
            messages.push(Message {
                role: "assistant".to_string(),
                content: response.content.clone(),
                name: None,
                tool_call_id: None,
                tool_calls: Some(
                    response
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
                        .collect(),
                ),
            });
            for call in &response.tool_calls {
                let outcome = match self.registry.get(&call.func_name) {
                    Some(tool)
                        if DEFAULT_CALLABLE_TOOLS.contains(&call.func_name.as_str())
                            && declared
                                .is_none_or(|list| list.iter().any(|t| t == &call.func_name)) =>
                    {
                        tool.execute(&call.arguments)
                            .await
                            .unwrap_or_else(|error| format!("执行失败: {error}"))
                    }
                    _ => format!("执行拒绝: 工具 '{}' 不能在 infer 中调用", call.func_name),
                };
                messages.push(Message {
                    role: "tool".to_string(),
                    content: outcome,
                    name: Some(call.func_name.clone()),
                    tool_call_id: Some(call.id.clone()),
                    tool_calls: None,
                });
            }
        }
        Err("infer 未能在预算内产出值".into())
    }
}

async fn run_episode(
    client: Arc<dyn Client>,
    run: usize,
    task: &EvalTask,
    scratch: &Path,
) -> EpisodeReport {
    let sandbox = scratch.join(format!("run-{run}-{}", task.id));
    let mut report = EpisodeReport {
        run,
        task: task.id.to_string(),
        used_eval: false,
        first_program_valid: None,
        repaired_after_feedback: None,
        programs: Vec::new(),
        infer_requests: 0,
        model_requests: 0,
        direct_tool_calls: 0,
        answer_correct: false,
        success: false,
        criteria: Vec::new(),
        final_answer: String::new(),
        error: None,
    };
    if let Err(error) = write_fixtures(&sandbox) {
        report.error = Some(format!("fixture 准备失败: {error}"));
        return report;
    }
    let registry = sandbox_registry(&sandbox);
    let infer_requests = Arc::new(Mutex::new(0usize));
    let inference: Arc<dyn RuntimeInference> = Arc::new(DirectInference {
        client: Arc::clone(&client),
        registry: Arc::clone(&registry),
        infer_requests: Arc::clone(&infer_requests),
    });

    let offered = registry.definitions();
    let system_prompt = match morphz::orchestrator::orchestrator::production_system_prompt() {
        Ok(prompt) => prompt.to_string(),
        Err(error) => {
            report.error = Some(format!("无法取得生产系统提示词: {error}"));
            return report;
        }
    };
    let mut messages = vec![
        Message {
            role: "system".to_string(),
            content: system_prompt,
            name: None,
            tool_call_id: None,
            tool_calls: None,
        },
        Message {
            role: "user".to_string(),
            content: task.prompt.to_string(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        },
    ];

    for turn in 1..=MAX_TURNS {
        report.model_requests += 1;
        let response = match client
            .create_completion(messages.clone(), offered.clone())
            .await
        {
            Ok(response) => response,
            Err(error) => {
                report.error = Some(error.to_string());
                break;
            }
        };
        if response.tool_calls.is_empty() {
            report.final_answer = response.content;
            break;
        }
        messages.push(Message {
            role: "assistant".to_string(),
            content: response.content.clone(),
            name: None,
            tool_call_id: None,
            tool_calls: Some(
                response
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
                    .collect(),
            ),
        });
        for call in &response.tool_calls {
            let output = if call.func_name == "eval" {
                report.used_eval = true;
                let source = serde_json::from_str::<JsonValue>(&call.arguments)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("program")
                            .and_then(|program| program.as_str())
                            .map(ToOwned::to_owned)
                    })
                    .unwrap_or_else(|| call.arguments.clone());
                let tool = registry.get("eval").expect("eval registered");
                let outcome = CURRENT_INFERENCE
                    .scope(Some(Arc::clone(&inference)), tool.execute(&call.arguments))
                    .await;
                let (valid, text, error) = match outcome {
                    Ok(text) => (true, text, None),
                    Err(error) => (false, format!("执行失败: {error}"), Some(error.to_string())),
                };
                report.programs.push(ProgramAttempt {
                    turn,
                    source,
                    valid,
                    error,
                });
                if report.first_program_valid.is_none() {
                    report.first_program_valid = Some(valid);
                }
                if valid && report.first_program_valid == Some(false) {
                    report.repaired_after_feedback = Some(true);
                }
                text
            } else {
                report.direct_tool_calls += 1;
                match registry.get(&call.func_name) {
                    Some(tool) => tool
                        .execute(&call.arguments)
                        .await
                        .unwrap_or_else(|error| format!("执行失败: {error}")),
                    None => format!("执行失败: 未注册的工具 {}", call.func_name),
                }
            };
            messages.push(Message {
                role: "tool".to_string(),
                content: output,
                name: Some(call.func_name.clone()),
                tool_call_id: Some(call.id.clone()),
                tool_calls: None,
            });
        }
    }

    if report.first_program_valid == Some(false) && report.repaired_after_feedback.is_none() {
        report.repaired_after_feedback = Some(false);
    }
    report.infer_requests = *infer_requests.lock().unwrap();
    score_episode(task, &mut report);
    let _ = std::fs::remove_dir_all(&sandbox);
    report
}

fn score_episode(task: &EvalTask, report: &mut EpisodeReport) {
    let answer = report.final_answer.as_str();
    let mut criteria = Vec::new();
    let mut push = |id: &str, passed: bool, detail: String| {
        criteria.push(CriterionResult {
            id: id.to_string(),
            passed,
            detail,
        });
    };
    match task.id {
        "todo-fanout" => {
            push(
                "finds-both-todo-files",
                answer.contains("alpha.rs") && answer.contains("gamma.rs"),
                format!("answer: {answer}"),
            );
        }
        "pointer-chase" => {
            push(
                "reports-passphrase",
                answer.contains("MOONGATE-88"),
                format!("answer: {answer}"),
            );
            let chained = report.programs.iter().any(|program| {
                program.valid && program.source.contains("bind") && program.source.contains('$')
            });
            push(
                "dataflow-through-binding",
                chained,
                "程序应通过 bind + $引用 传递文件名".to_string(),
            );
        }
        "infer-classify" => {
            push(
                "classifies-security",
                answer.contains("安全"),
                format!("answer: {answer}"),
            );
            push(
                "used-infer",
                report.infer_requests > 0,
                format!("infer_requests={}", report.infer_requests),
            );
        }
        "declared-tools" => {
            let declared_program = report
                .programs
                .iter()
                .any(|program| program.valid && program.source.trim_start().starts_with("(tools"));
            push(
                "declares-tools",
                declared_program,
                "程序开头应有 (tools ...) 声明".to_string(),
            );
            push(
                "reports-todo-content",
                answer.contains("optimize"),
                format!("answer: {answer}"),
            );
        }
        _ => {}
    }
    report.answer_correct = criteria
        .iter()
        .filter(|criterion| {
            criterion.id.starts_with("reports-")
                || criterion.id.starts_with("finds-")
                || criterion.id.starts_with("classifies-")
        })
        .all(|criterion| criterion.passed);
    report.success = report.used_eval
        && report.programs.iter().any(|program| program.valid)
        && criteria.iter().all(|criterion| criterion.passed);
    report.criteria = criteria;
}

fn summarize(episodes: &[EpisodeReport]) -> Vec<TaskSummary> {
    let mut summaries: Vec<TaskSummary> = Vec::new();
    for episode in episodes {
        let summary = match summaries.iter_mut().find(|s| s.task == episode.task) {
            Some(summary) => summary,
            None => {
                summaries.push(TaskSummary {
                    task: episode.task.clone(),
                    episodes: 0,
                    eval_adoption: 0,
                    first_try_valid: 0,
                    repaired: 0,
                    answer_correct: 0,
                    success: 0,
                });
                summaries.last_mut().expect("just pushed")
            }
        };
        summary.episodes += 1;
        summary.eval_adoption += usize::from(episode.used_eval);
        summary.first_try_valid += usize::from(episode.first_program_valid == Some(true));
        summary.repaired += usize::from(episode.repaired_after_feedback == Some(true));
        summary.answer_correct += usize::from(episode.answer_correct);
        summary.success += usize::from(episode.success);
    }
    summaries
}

pub async fn run_yao_program_eval(
    output_base: &Path,
    repetitions: usize,
) -> Result<YaoProgramEvalReport, DynError> {
    if repetitions == 0 {
        return Err("repetitions 必须大于 0".into());
    }
    let (client, model) = crate::configured_model_client()?;
    let id = format!(
        "yao-program-eval-v1-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    );
    let output_dir = output_base.join(&id);
    std::fs::create_dir_all(&output_dir)?;
    let scratch = output_dir.join("sandboxes");
    std::fs::create_dir_all(&scratch)?;

    let mut episodes = Vec::new();
    for run in 1..=repetitions {
        for task in tasks() {
            let episode = run_episode(Arc::clone(&client), run, &task, &scratch).await;
            std::fs::write(
                output_dir.join(format!("run-{run}-{}.json", task.id)),
                serde_json::to_vec_pretty(&episode)?,
            )?;
            episodes.push(episode);
        }
    }

    let report = YaoProgramEvalReport {
        id,
        created_at: Utc::now().to_rfc3339(),
        model,
        repetitions,
        output_dir: output_dir.clone(),
        summaries: summarize(&episodes),
        episodes,
        conclusion_boundary:
            "本评测隔离测量模型对爻语言表面的掌握：仅凭 eval 工具描述能否写出合法程序、\
            验证反馈能否引导修复、任务成形时是否采用 eval。infer 宿主为评测内直连实现，\
            与 Orchestrator 生产路径同形但不含准入、预算与持久化 Event 接线；生产接线由集成测试覆盖。"
                .to_string(),
    };
    std::fs::write(
        output_dir.join("report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(report)
}
