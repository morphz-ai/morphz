use chrono::Utc;
use morphz::config;
use morphz::llm::{
    Client, Message, ModelAttemptBinding, ModelRequestContext, ModelRequestOptions,
    ModelStreamEvent, ModelUsage, ReasoningEffort,
};
use morphz::provider::build_configured_client;
use morphz::runtime::MorphzRuntime;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

type DynError = Box<dyn std::error::Error + Send + Sync>;

const PROFILE: &str = "roadshow-demo-001";
const PROVIDER: &str = "custom";
const MODEL: &str = "gpt-5.6-sol";
const SYSTEM_CONTRACT: &str = r#"You are the model-owned evaluator at a typed cognitive boundary.

For BOUNDED_OPEN, the relation deliberately permits more than one valid result. Select any result that satisfies the current Context and the declared contract. Do not search for a hidden unique optimum.

For CLOSED, apply the declared deterministic rule exactly. Context preferences that are relevant only to the open judgment do not override the closed rule.

Nondeterministic means that multiple values may satisfy one semantic contract; it does not require randomness. Return exactly one JSON object and no Markdown."#;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Candidate {
    id: String,
    properties: Vec<String>,
    closed_score: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ContextVariant {
    id: String,
    statement: String,
    required_property_groups: Vec<Vec<String>>,
    forbidden_properties: Vec<String>,
}

#[derive(Debug, Clone)]
struct EvalTask {
    id: &'static str,
    question: &'static str,
    candidates: Vec<Candidate>,
    base: ContextVariant,
    intervention: ContextVariant,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Condition {
    BoundedOpenBase,
    BoundedOpenIntervention,
    ClosedBase,
    ClosedIntervention,
}

impl Condition {
    const ALL: [Self; 4] = [
        Self::BoundedOpenBase,
        Self::BoundedOpenIntervention,
        Self::ClosedBase,
        Self::ClosedIntervention,
    ];

    fn name(self) -> &'static str {
        match self {
            Self::BoundedOpenBase => "bounded_open_base",
            Self::BoundedOpenIntervention => "bounded_open_intervention",
            Self::ClosedBase => "closed_base",
            Self::ClosedIntervention => "closed_intervention",
        }
    }

    fn is_open(self) -> bool {
        matches!(self, Self::BoundedOpenBase | Self::BoundedOpenIntervention)
    }

    fn is_intervention(self) -> bool {
        matches!(
            self,
            Self::BoundedOpenIntervention | Self::ClosedIntervention
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CandidateResult {
    selected: Vec<String>,
    basis: Vec<String>,
    explanation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CriterionResult {
    pub id: String,
    pub passed: bool,
    pub evidence: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestArtifact {
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
    pub task: String,
    pub condition: String,
    pub context_id: String,
    pub valid_open_set_count: Option<usize>,
    pub selected: Vec<String>,
    pub success: bool,
    pub criteria: Vec<CriterionResult>,
    pub raw_output: String,
    pub request: RequestArtifact,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConditionSummary {
    pub episodes: usize,
    pub passed: usize,
    pub pass_rate: f64,
    pub observed_unique_selections: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskAnalysis {
    pub task: String,
    pub base_valid_set_count: usize,
    pub intervention_valid_set_count: usize,
    pub observed_open_base_unique: usize,
    pub observed_open_intervention_unique: usize,
    pub paired_context_shift_passed: usize,
    pub paired_context_shift_total: usize,
    pub paired_closed_invariance_passed: usize,
    pub paired_closed_invariance_total: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Me03Report {
    pub id: String,
    pub created_at: String,
    pub model: String,
    pub provider: String,
    pub protocol: String,
    pub immutable_binding: ModelAttemptBinding,
    pub reasoning_effort: String,
    pub repetitions: usize,
    pub output_dir: PathBuf,
    pub summaries: BTreeMap<String, ConditionSummary>,
    pub task_analysis: Vec<TaskAnalysis>,
    pub episodes: Vec<EpisodeReport>,
    pub conclusion_boundary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptArtifact {
    pub task: String,
    pub condition: String,
    pub context_id: String,
    pub prompt_sha256: String,
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoModelGateReport {
    pub id: String,
    pub created_at: String,
    pub output_dir: PathBuf,
    pub tasks: usize,
    pub conditions_per_task: usize,
    pub open_multi_value_gate: bool,
    pub context_disjoint_gate: bool,
    pub closed_unique_gate: bool,
    pub scorer_positive_gate: bool,
    pub scorer_negative_gate: bool,
    pub prompt_contract_gate: bool,
    pub ready_for_real_pilot: bool,
    pub task_gates: Vec<TaskGateArtifact>,
    pub prompt_bundle: Vec<PromptArtifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskGateArtifact {
    pub task: String,
    pub base_context_id: String,
    pub base_valid_sets: Vec<Vec<String>>,
    pub intervention_context_id: String,
    pub intervention_valid_sets: Vec<Vec<String>>,
    pub closed_winner: String,
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
    let id = run_id("ME-03-no-model-p1");
    let output_dir = output_base.join(&id);
    std::fs::create_dir_all(&output_dir)?;
    let task_set = tasks();
    let prompt_bundle = prompt_bundle(&task_set)?;
    let task_gates = task_set
        .iter()
        .map(|task| TaskGateArtifact {
            task: task.id.to_string(),
            base_context_id: task.base.id.clone(),
            base_valid_sets: valid_open_sets(task, &task.base),
            intervention_context_id: task.intervention.id.clone(),
            intervention_valid_sets: valid_open_sets(task, &task.intervention),
            closed_winner: unique_closed_winner(task)
                .unwrap_or_else(|| "NO_UNIQUE_WINNER".to_string()),
        })
        .collect::<Vec<_>>();
    let open_multi_value_gate = task_set.iter().all(|task| {
        valid_open_sets(task, &task.base).len() >= 2
            && valid_open_sets(task, &task.intervention).len() >= 2
    });
    let context_disjoint_gate = task_set.iter().all(|task| {
        let base = valid_open_sets(task, &task.base)
            .into_iter()
            .collect::<BTreeSet<_>>();
        let intervention = valid_open_sets(task, &task.intervention)
            .into_iter()
            .collect::<BTreeSet<_>>();
        base.is_disjoint(&intervention)
    });
    let closed_unique_gate = task_set
        .iter()
        .all(|task| unique_closed_winner(task).is_some());
    let scorer_positive_gate = task_set.iter().all(scorer_accepts_all_positive_controls);
    let scorer_negative_gate = task_set.iter().all(scorer_rejects_negative_controls);
    let prompt_contract_gate = prompt_bundle.iter().all(|artifact| {
        artifact.prompt.contains("infer-request")
            && artifact.prompt.contains("selected")
            && artifact.prompt.contains(&artifact.context_id)
            && !artifact.prompt.contains("VALID_SET_ENUMERATION")
            && if artifact.condition.starts_with("bounded_open") {
                !artifact.prompt.contains("closed_score")
            } else {
                artifact.prompt.contains("closed_score")
            }
    });
    let ready_for_real_pilot = open_multi_value_gate
        && context_disjoint_gate
        && closed_unique_gate
        && scorer_positive_gate
        && scorer_negative_gate
        && prompt_contract_gate;
    std::fs::write(
        output_dir.join("prompt_bundle.json"),
        serde_json::to_vec_pretty(&prompt_bundle)?,
    )?;
    let report = NoModelGateReport {
        id,
        created_at: Utc::now().to_rfc3339(),
        output_dir: output_dir.clone(),
        tasks: task_set.len(),
        conditions_per_task: Condition::ALL.len(),
        open_multi_value_gate,
        context_disjoint_gate,
        closed_unique_gate,
        scorer_positive_gate,
        scorer_negative_gate,
        prompt_contract_gate,
        ready_for_real_pilot,
        task_gates,
        prompt_bundle,
    };
    std::fs::write(
        output_dir.join("gate_report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(report)
}

pub async fn run_binding_preflight(output_base: &Path) -> Result<BindingPreflightReport, DynError> {
    let id = run_id("ME-03-binding-preflight-p1");
    let output_dir = output_base.join(&id);
    std::fs::create_dir_all(&output_dir)?;
    let (_client, _runtime_guard, binding) = exact_model_client(&output_dir).await?;
    let report = BindingPreflightReport {
        id,
        created_at: Utc::now().to_rfc3339(),
        profile: PROFILE.to_string(),
        requested_reasoning_effort: ReasoningEffort::Max.as_str().to_string(),
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
) -> Result<Me03Report, DynError> {
    if repetitions == 0 {
        return Err("repetitions must be greater than zero".into());
    }
    let id = run_id("ME-03-pilot-p1");
    let output_dir = output_base.join(&id);
    std::fs::create_dir_all(&output_dir)?;
    let (client, _runtime_guard, binding) = exact_model_client(&output_dir).await?;
    let task_set = tasks();
    std::fs::write(
        output_dir.join("prompt_bundle.json"),
        serde_json::to_vec_pretty(&prompt_bundle(&task_set)?)?,
    )?;
    let mut episodes = Vec::new();
    for repetition in 1..=repetitions {
        for (task_index, task) in task_set.iter().enumerate() {
            let rotation = (task_index + repetition - 1) % Condition::ALL.len();
            for offset in 0..Condition::ALL.len() {
                let condition = Condition::ALL[(rotation + offset) % Condition::ALL.len()];
                let episode =
                    run_episode(client.as_ref(), &binding, repetition, task, condition).await?;
                std::fs::write(
                    output_dir.join(format!(
                        "episode-{:02}-{}-{}.json",
                        repetition,
                        task.id,
                        condition.name()
                    )),
                    serde_json::to_vec_pretty(&episode)?,
                )?;
                episodes.push(episode);
            }
        }
    }
    let report = Me03Report {
        id,
        created_at: Utc::now().to_rfc3339(),
        model: binding.physical_model.clone(),
        provider: binding.provider_instance_id.clone(),
        protocol: binding.protocol.clone(),
        immutable_binding: binding,
        reasoning_effort: "requested=max; client=max; per-request-options=max".to_string(),
        repetitions,
        output_dir: output_dir.clone(),
        summaries: summarize(&episodes),
        task_analysis: analyze_tasks(&task_set, &episodes, repetitions),
        episodes,
        conclusion_boundary: "ME-03 p1 tests bounded-open contract validity, Context intervention sensitivity and closed-operator invariance. Diversity is descriptive and is not induced through temperature. This Pilot does not establish cross-model generality, S-expression superiority, long-context advantage or Runtime authority guarantees.".to_string(),
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
    repetition: usize,
    task: &EvalTask,
    condition: Condition,
) -> Result<EpisodeReport, DynError> {
    let prompt = render_prompt(task, condition)?;
    let messages = vec![message("system", SYSTEM_CONTRACT), message("user", &prompt)];
    let measurement = client
        .count_prompt_tokens(
            &format!("ME-03/{}/{}/{}", task.id, condition.name(), repetition),
            &messages,
            &[],
        )
        .await?;
    let (stream_sender, mut stream_receiver) = tokio::sync::mpsc::unbounded_channel();
    let completion = client
        .create_completion_bound_stream_with_options(
            binding,
            messages.clone(),
            Vec::new(),
            measurement.clone(),
            stream_sender,
            ModelRequestOptions {
                reasoning_effort: Some(Some(ReasoningEffort::Max)),
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
    let (response, error, raw_output) = match completion {
        Ok(response) => (Some(response.clone()), None, response.content),
        Err(error) => (None, Some(error.to_string()), String::new()),
    };
    let context = context_for(task, condition);
    let criteria = if error.is_none() {
        score_output(task, condition, &raw_output)
    } else {
        vec![criterion(
            "provider-completion",
            false,
            error.clone().unwrap(),
        )]
    };
    let selected = serde_json::from_str::<CandidateResult>(&raw_output)
        .map(|parsed| canonical_selection(&parsed.selected))
        .unwrap_or_default();
    Ok(EpisodeReport {
        repetition,
        task: task.id.to_string(),
        condition: condition.name().to_string(),
        context_id: context.id.clone(),
        valid_open_set_count: condition
            .is_open()
            .then(|| valid_open_sets(task, context).len()),
        selected,
        success: criteria.iter().all(|item| item.passed),
        criteria,
        raw_output,
        request: RequestArtifact {
            prompt_measurement: measurement,
            messages,
            response,
            stream_events,
            usage,
            error,
        },
    })
}

async fn exact_model_client(
    run_root: &Path,
) -> Result<(Arc<dyn Client>, MorphzRuntime, ModelAttemptBinding), DynError> {
    if let Some(path) = config::host_env_path() {
        if let Err(error) = config::load_env(&path.to_string_lossy()) {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(format!("failed to load Morphz host environment: {error}").into());
            }
        }
    }
    let cwd = std::env::current_dir()?;
    let mut resolved = config::resolve_config(&cwd, None, Some(PROFILE))?;
    resolved.config.apply_runtime_env_overrides()?;
    let route = resolved
        .config
        .model_routes
        .get(MODEL)
        .ok_or("ME-03 exact gpt-5.6-sol route is not configured")?;
    if route.fallback || route.candidates.len() != 1 {
        return Err("ME-03 requires one gpt-5.6-sol candidate and fallback=false".into());
    }
    let candidate = &route.candidates[0];
    if candidate.provider != PROVIDER || candidate.model != MODEL {
        return Err("ME-03 profile is not bound to custom/gpt-5.6-sol".into());
    }
    resolved.config.llm.model = MODEL.to_string();
    resolved.config.llm.reasoning_effort = Some(ReasoningEffort::Max);
    resolved.config.llm.max_output_tokens = Some(1_024);
    let (client, selected) = build_configured_client(&resolved.config, None, Some(MODEL))?;
    if selected.id != PROVIDER || selected.model != MODEL {
        return Err("ME-03 configured client selected a different model/provider".into());
    }
    client.set_reasoning_effort(Some(ReasoningEffort::Max))?;
    if client.reasoning_effort() != Some(ReasoningEffort::Max) {
        return Err("ME-03 client did not retain reasoning=max".into());
    }
    let runtime = MorphzRuntime::builder(resolved.config, Arc::clone(&client))
        .database_path(run_root.join("provider-control.db").to_string_lossy())
        .build()
        .await?;
    let binding = client
        .bind_model_attempt(&ModelRequestContext {
            context_id: "me03-provider-preflight".to_string(),
            session_id: "me03-provider-preflight".to_string(),
            attempt_id: "me03-provider-preflight".to_string(),
            objective_id: None,
            required_capabilities: Vec::new(),
        })
        .await?;
    if binding.requested_alias != MODEL
        || binding.physical_model != MODEL
        || binding.provider_instance_id != PROVIDER
        || binding.protocol != "openai-responses"
    {
        return Err(format!(
            "ME-03 exact binding mismatch: alias={}, provider={}, physical={}, protocol={}",
            binding.requested_alias,
            binding.provider_instance_id,
            binding.physical_model,
            binding.protocol
        )
        .into());
    }
    Ok((client, runtime, binding))
}

fn render_prompt(task: &EvalTask, condition: Condition) -> Result<String, DynError> {
    let context = context_for(task, condition);
    let kind = if condition.is_open() {
        "BOUNDED_OPEN"
    } else {
        "CLOSED"
    };
    let rule = if condition.is_open() {
        json!({
            "select_count": 2,
            "semantics": "Choose any two distinct candidates such that no selected candidate has a forbidden property and the selected set collectively covers at least one property from every required_property_group.",
            "required_property_groups": context.required_property_groups,
            "forbidden_properties": context.forbidden_properties,
        })
    } else {
        json!({
            "select_count": 1,
            "semantics": "Ignore open-preference constraints and select the unique candidate with the greatest closed_score."
        })
    };
    let visible_candidates = task
        .candidates
        .iter()
        .map(|candidate| {
            if condition.is_open() {
                json!({
                    "id": candidate.id,
                    "properties": candidate.properties,
                })
            } else {
                serde_json::to_value(candidate).expect("candidate serialization cannot fail")
            }
        })
        .collect::<Vec<_>>();
    let request = json!({
        "kind": kind,
        "task": task.question,
        "context": context,
        "candidates": visible_candidates,
        "rule": rule,
        "returns": {
            "selected": "array of candidate ids",
            "basis": "non-empty array containing the current context id for BOUNDED_OPEN, or closed-score-rule for CLOSED",
            "explanation": "non-empty short string"
        }
    });
    Ok(format!(
        "(infer-request\n{}\n)",
        serde_json::to_string_pretty(&request)?
    ))
}

fn prompt_bundle(tasks: &[EvalTask]) -> Result<Vec<PromptArtifact>, DynError> {
    let mut bundle = Vec::new();
    for task in tasks {
        for condition in Condition::ALL {
            let prompt = render_prompt(task, condition)?;
            bundle.push(PromptArtifact {
                task: task.id.to_string(),
                condition: condition.name().to_string(),
                context_id: context_for(task, condition).id.clone(),
                prompt_sha256: sha256_hex(prompt.as_bytes()),
                prompt,
            });
        }
    }
    Ok(bundle)
}

fn score_output(task: &EvalTask, condition: Condition, raw: &str) -> Vec<CriterionResult> {
    let parsed = match serde_json::from_str::<CandidateResult>(raw) {
        Ok(parsed) => parsed,
        Err(error) => {
            return vec![criterion(
                "typed-json-contract",
                false,
                format!("invalid exact JSON object: {error}"),
            )]
        }
    };
    let selected = canonical_selection(&parsed.selected);
    let expected_count = if condition.is_open() { 2 } else { 1 };
    let cardinality = selected.len() == expected_count && parsed.selected.len() == expected_count;
    let known = selected.iter().all(|id| candidate(task, id).is_some());
    let context = context_for(task, condition);
    let contract = if condition.is_open() {
        valid_open_sets(task, context).contains(&selected)
    } else {
        unique_closed_winner(task).is_some_and(|winner| selected == vec![winner])
    };
    let expected_basis = if condition.is_open() {
        context.id.as_str()
    } else {
        "closed-score-rule"
    };
    vec![
        criterion("typed-json-contract", true, "exact schema decoded"),
        criterion(
            "selection-cardinality",
            cardinality,
            format!("expected {expected_count}, got {}", parsed.selected.len()),
        ),
        criterion("known-candidates", known, format!("selected={selected:?}")),
        criterion(
            "semantic-contract",
            contract,
            format!("selected={selected:?}"),
        ),
        criterion(
            "causal-basis",
            parsed.basis.iter().any(|basis| basis == expected_basis),
            format!("expected basis {expected_basis}"),
        ),
        criterion(
            "nonempty-explanation",
            !parsed.explanation.trim().is_empty(),
            "explanation must not be empty",
        ),
    ]
}

fn valid_open_sets(task: &EvalTask, context: &ContextVariant) -> Vec<Vec<String>> {
    let mut valid = Vec::new();
    for left in 0..task.candidates.len() {
        for right in (left + 1)..task.candidates.len() {
            let selected = [&task.candidates[left], &task.candidates[right]];
            let forbidden = selected.iter().any(|candidate| {
                candidate.properties.iter().any(|property| {
                    context
                        .forbidden_properties
                        .iter()
                        .any(|forbidden| forbidden == property)
                })
            });
            let groups_covered = context.required_property_groups.iter().all(|group| {
                selected.iter().any(|candidate| {
                    candidate
                        .properties
                        .iter()
                        .any(|property| group.iter().any(|required| required == property))
                })
            });
            if !forbidden && groups_covered {
                valid.push(canonical_selection(&[
                    task.candidates[left].id.clone(),
                    task.candidates[right].id.clone(),
                ]));
            }
        }
    }
    valid.sort();
    valid.dedup();
    valid
}

fn unique_closed_winner(task: &EvalTask) -> Option<String> {
    let max = task.candidates.iter().map(|item| item.closed_score).max()?;
    let winners = task
        .candidates
        .iter()
        .filter(|item| item.closed_score == max)
        .collect::<Vec<_>>();
    (winners.len() == 1).then(|| winners[0].id.clone())
}

fn scorer_accepts_all_positive_controls(task: &EvalTask) -> bool {
    for condition in [
        Condition::BoundedOpenBase,
        Condition::BoundedOpenIntervention,
    ] {
        let context = context_for(task, condition);
        for selected in valid_open_sets(task, context) {
            let output = json!({
                "selected": selected,
                "basis": [context.id],
                "explanation": "contract-valid positive control"
            });
            if !score_output(task, condition, &output.to_string())
                .iter()
                .all(|item| item.passed)
            {
                return false;
            }
        }
    }
    let Some(winner) = unique_closed_winner(task) else {
        return false;
    };
    for condition in [Condition::ClosedBase, Condition::ClosedIntervention] {
        let output = json!({
            "selected": [winner],
            "basis": ["closed-score-rule"],
            "explanation": "unique closed positive control"
        });
        if !score_output(task, condition, &output.to_string())
            .iter()
            .all(|item| item.passed)
        {
            return false;
        }
    }
    true
}

fn scorer_rejects_negative_controls(task: &EvalTask) -> bool {
    let context = &task.base;
    let invalids = [
        "not json".to_string(),
        json!({"selected":["unknown","unknown-2"],"basis":[context.id],"explanation":"x"}).to_string(),
        json!({"selected":[task.candidates[0].id],"basis":[context.id],"explanation":"x"}).to_string(),
        json!({"selected":valid_open_sets(task, context)[0],"basis":["wrong-context"],"explanation":"x"}).to_string(),
    ];
    let open_rejected = invalids.iter().all(|output| {
        !score_output(task, Condition::BoundedOpenBase, output)
            .iter()
            .all(|item| item.passed)
    });
    let wrong_closed = task
        .candidates
        .iter()
        .find(|candidate| Some(candidate.id.clone()) != unique_closed_winner(task))
        .expect("task has more than one candidate");
    let closed_output = json!({
        "selected":[wrong_closed.id],
        "basis":["closed-score-rule"],
        "explanation":"wrong maximum"
    });
    open_rejected
        && !score_output(task, Condition::ClosedBase, &closed_output.to_string())
            .iter()
            .all(|item| item.passed)
}

fn summarize(episodes: &[EpisodeReport]) -> BTreeMap<String, ConditionSummary> {
    let mut output = BTreeMap::new();
    for condition in Condition::ALL {
        let matching = episodes
            .iter()
            .filter(|episode| episode.condition == condition.name())
            .collect::<Vec<_>>();
        let unique = matching
            .iter()
            .filter(|episode| episode.success)
            .map(|episode| episode.selected.clone())
            .collect::<BTreeSet<_>>()
            .len();
        let passed = matching.iter().filter(|episode| episode.success).count();
        output.insert(
            condition.name().to_string(),
            ConditionSummary {
                episodes: matching.len(),
                passed,
                pass_rate: if matching.is_empty() {
                    0.0
                } else {
                    passed as f64 / matching.len() as f64
                },
                observed_unique_selections: unique,
            },
        );
    }
    output
}

fn analyze_tasks(
    tasks: &[EvalTask],
    episodes: &[EpisodeReport],
    repetitions: usize,
) -> Vec<TaskAnalysis> {
    tasks
        .iter()
        .map(|task| {
            let selected_for = |condition: Condition| {
                episodes
                    .iter()
                    .filter(|episode| {
                        episode.task == task.id
                            && episode.condition == condition.name()
                            && episode.success
                    })
                    .map(|episode| (episode.repetition, episode.selected.clone()))
                    .collect::<BTreeMap<_, _>>()
            };
            let open_base = selected_for(Condition::BoundedOpenBase);
            let open_intervention = selected_for(Condition::BoundedOpenIntervention);
            let closed_base = selected_for(Condition::ClosedBase);
            let closed_intervention = selected_for(Condition::ClosedIntervention);
            let context_shift_passed = (1..=repetitions)
                .filter(|repetition| {
                    open_base.get(repetition).is_some_and(|base| {
                        open_intervention
                            .get(repetition)
                            .is_some_and(|intervention| base != intervention)
                    })
                })
                .count();
            let closed_invariance_passed = (1..=repetitions)
                .filter(|repetition| {
                    closed_base.get(repetition).is_some_and(|base| {
                        closed_intervention
                            .get(repetition)
                            .is_some_and(|intervention| base == intervention)
                    })
                })
                .count();
            TaskAnalysis {
                task: task.id.to_string(),
                base_valid_set_count: valid_open_sets(task, &task.base).len(),
                intervention_valid_set_count: valid_open_sets(task, &task.intervention).len(),
                observed_open_base_unique: open_base.values().collect::<BTreeSet<_>>().len(),
                observed_open_intervention_unique: open_intervention
                    .values()
                    .collect::<BTreeSet<_>>()
                    .len(),
                paired_context_shift_passed: context_shift_passed,
                paired_context_shift_total: repetitions,
                paired_closed_invariance_passed: closed_invariance_passed,
                paired_closed_invariance_total: repetitions,
            }
        })
        .collect()
}

fn context_for(task: &EvalTask, condition: Condition) -> &ContextVariant {
    if condition.is_intervention() {
        &task.intervention
    } else {
        &task.base
    }
}

fn candidate<'a>(task: &'a EvalTask, id: &str) -> Option<&'a Candidate> {
    task.candidates.iter().find(|candidate| candidate.id == id)
}

fn canonical_selection(values: &[String]) -> Vec<String> {
    let mut values = values.to_vec();
    values.sort();
    values.dedup();
    values
}

fn criterion(id: &str, passed: bool, evidence: impl Into<String>) -> CriterionResult {
    CriterionResult {
        id: id.to_string(),
        passed,
        evidence: evidence.into(),
    }
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

fn run_id(prefix: &str) -> String {
    format!(
        "{}-{}-{}",
        prefix,
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        std::process::id()
    )
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn candidate_value(id: &str, properties: &[&str], closed_score: u32) -> Candidate {
    Candidate {
        id: id.to_string(),
        properties: strings(properties),
        closed_score,
    }
}

fn context(
    id: &str,
    statement: &str,
    required_property_groups: &[&[&str]],
    forbidden_properties: &[&str],
) -> ContextVariant {
    ContextVariant {
        id: id.to_string(),
        statement: statement.to_string(),
        required_property_groups: required_property_groups
            .iter()
            .map(|group| strings(group))
            .collect(),
        forbidden_properties: strings(forbidden_properties),
    }
}

fn tasks() -> Vec<EvalTask> {
    vec![incident_response(), release_strategy(), research_strategy()]
}

fn incident_response() -> EvalTask {
    EvalTask {
        id: "incident_response",
        question: "Choose the candidate action or actions required by the declared evaluation rule for the current incident.",
        candidates: vec![
            candidate_value("isolate_edge", &["containment", "disruptive", "internal"], 71),
            candidate_value("rotate_tokens", &["containment", "low_disruption", "internal"], 83),
            candidate_value("rate_limit", &["containment", "low_disruption", "reversible", "internal"], 88),
            candidate_value("publish_status", &["transparency", "low_disruption", "external"], 67),
            candidate_value("notify_affected", &["transparency", "evidence", "external"], 74),
            candidate_value("preserve_logs", &["evidence", "low_disruption", "internal"], 79),
        ],
        base: context(
            "incident-continuity-v1",
            "Maintain service continuity while containing the incident; external communication is not yet authorized.",
            &[&["containment"], &["low_disruption"]],
            &["external"],
        ),
        intervention: context(
            "incident-accountability-v2",
            "An authoritative disclosure decision now prioritizes public accountability and preservation of evidence.",
            &[&["transparency"], &["evidence"]],
            &["disruptive"],
        ),
    }
}

fn release_strategy() -> EvalTask {
    EvalTask {
        id: "release_strategy",
        question: "Choose the candidate release mechanism or mechanisms required by the declared evaluation rule.",
        candidates: vec![
            candidate_value("blue_green", &["gradual", "reversible", "capacity_heavy"], 82),
            candidate_value("canary", &["gradual", "reversible", "observability"], 91),
            candidate_value("rolling", &["gradual", "capacity_light"], 76),
            candidate_value("hot_swap", &["rapid", "reversible", "capacity_light"], 85),
            candidate_value("feature_flag", &["rapid", "reversible", "observability"], 89),
            candidate_value("big_bang", &["rapid", "capacity_light"], 58),
        ],
        base: context(
            "release-risk-control-v1",
            "The normal release policy prioritizes gradual rollout and reversibility; rapid-only mechanisms are excluded.",
            &[&["gradual"], &["reversible"]],
            &["rapid"],
        ),
        intervention: context(
            "release-deadline-v2",
            "A newly approved emergency deadline requires rapid delivery with a capacity-light path; gradual-only mechanisms are excluded.",
            &[&["rapid"], &["capacity_light"]],
            &["gradual"],
        ),
    }
}

fn research_strategy() -> EvalTask {
    EvalTask {
        id: "research_strategy",
        question: "Choose the candidate research method or methods required by the declared evaluation rule.",
        candidates: vec![
            candidate_value("broad_scan", &["breadth", "secondary", "fast"], 73),
            candidate_value("expert_interviews", &["breadth", "primary", "qualitative"], 81),
            candidate_value("controlled_trial", &["depth", "primary", "causal"], 94),
            candidate_value("replication", &["depth", "primary", "verification"], 90),
            candidate_value("dataset_audit", &["depth", "secondary", "verification"], 86),
            candidate_value("field_observation", &["breadth", "primary", "field"], 78),
        ],
        base: context(
            "research-landscape-v1",
            "The current stage maps the landscape broadly and quickly; causal experiments are premature.",
            &[&["breadth"], &["fast"]],
            &["causal"],
        ),
        intervention: context(
            "research-causal-v2",
            "New funding authorizes causal validation using primary evidence; secondary-only methods are excluded.",
            &[&["depth"], &["primary"]],
            &["secondary"],
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_open_context_has_multiple_disjoint_values() {
        for task in tasks() {
            let base = valid_open_sets(&task, &task.base)
                .into_iter()
                .collect::<BTreeSet<_>>();
            let intervention = valid_open_sets(&task, &task.intervention)
                .into_iter()
                .collect::<BTreeSet<_>>();
            assert!(base.len() >= 2, "{} base: {base:?}", task.id);
            assert!(
                intervention.len() >= 2,
                "{} intervention: {intervention:?}",
                task.id
            );
            assert!(base.is_disjoint(&intervention), "{} overlap", task.id);
        }
    }

    #[test]
    fn every_closed_rule_has_one_winner() {
        for task in tasks() {
            assert!(unique_closed_winner(&task).is_some(), "{}", task.id);
        }
    }

    #[test]
    fn scorer_positive_and_negative_controls_are_separated() {
        for task in tasks() {
            assert!(scorer_accepts_all_positive_controls(&task), "{}", task.id);
            assert!(scorer_rejects_negative_controls(&task), "{}", task.id);
        }
    }

    #[test]
    fn prompt_bundle_has_all_conditions_without_enumerated_answers() {
        let bundle = prompt_bundle(&tasks()).unwrap();
        assert_eq!(bundle.len(), 12);
        assert!(bundle
            .iter()
            .all(|artifact| artifact.prompt.contains("infer-request")));
        assert!(bundle
            .iter()
            .all(|artifact| !artifact.prompt.contains("VALID_SET_ENUMERATION")));
    }
}
