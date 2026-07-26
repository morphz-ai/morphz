use crate::{configured_model_client_with_config, EvalError};
use morphz::config::{AppConfig, ModelUsagePrice};
use morphz::llm::{Message, ModelStreamEvent, ModelUsage, PromptTokenCount, ReasoningEffort};
use morphz::orchestrator::orchestrator::production_system_prompt;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone)]
pub struct PrefixCacheEvalConfig {
    pub history_chars: usize,
    pub observations: usize,
    /// Cached input expressed in uncached-input-equivalent tokens when no
    /// monetary pricing is configured.
    pub cached_input_discount: f64,
    /// Cache writes expressed in uncached-input-equivalent tokens.
    pub cache_write_input_multiplier: f64,
    /// Output expressed in uncached-input-equivalent tokens.
    pub output_input_multiplier: f64,
    /// Explicit benchmark pricing overrides the configured model catalog.
    pub prices_per_million: Option<TokenPrices>,
}

impl Default for PrefixCacheEvalConfig {
    fn default() -> Self {
        Self {
            history_chars: 180_000,
            observations: 480,
            cached_input_discount: 0.1,
            cache_write_input_multiplier: 1.0,
            output_input_multiplier: 4.0,
            prices_per_million: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenPrices {
    pub currency: String,
    pub version: String,
    pub uncached_input: f64,
    pub cached_input: f64,
    pub cache_write_input: Option<f64>,
    pub output: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LayoutArm {
    Current,
    InboxFirst,
}

impl LayoutArm {
    fn as_str(self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::InboxFirst => "inbox-first",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scenario {
    Warm,
    AppendOne,
    AppendTwo,
    MindRevision,
    RetireOldestQuarter,
    AppendAfterRetireOne,
    AppendAfterRetireTwo,
    AppendAfterRetireThree,
}

impl Scenario {
    fn as_str(self) -> &'static str {
        match self {
            Self::Warm => "warm",
            Self::AppendOne => "append-one",
            Self::AppendTwo => "append-two",
            Self::MindRevision => "mind-revision",
            Self::RetireOldestQuarter => "retire-oldest-quarter",
            Self::AppendAfterRetireOne => "append-after-retire-one",
            Self::AppendAfterRetireTwo => "append-after-retire-two",
            Self::AppendAfterRetireThree => "append-after-retire-three",
        }
    }

    fn new_observations(self) -> usize {
        match self {
            Self::AppendOne
            | Self::AppendTwo
            | Self::AppendAfterRetireOne
            | Self::AppendAfterRetireTwo
            | Self::AppendAfterRetireThree => 1,
            Self::Warm | Self::MindRevision | Self::RetireOldestQuarter => 0,
        }
    }

    fn is_warmup(self) -> bool {
        self == Self::Warm
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrefixCacheStepReport {
    pub arm: String,
    pub scenario: String,
    pub warmup: bool,
    pub request_chars: usize,
    pub active_context_chars: usize,
    pub active_context_estimated_tokens: Option<usize>,
    pub active_context_estimate_source: Option<String>,
    pub full_prompt_estimated_tokens: Option<usize>,
    pub full_prompt_estimate_source: Option<String>,
    pub common_prefix_chars: usize,
    pub structural_prefix_ratio: f64,
    pub new_observations: usize,
    pub input_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub cache_write_input_tokens: Option<u64>,
    pub uncached_input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_hit_rate: Option<f64>,
    /// Not money: all categories converted to uncached-input-equivalent
    /// tokens using the configured benchmark weights.
    pub weighted_token_cost: Option<f64>,
    pub weighted_cost_per_new_observation: Option<f64>,
    pub estimated_currency_cost: Option<f64>,
    pub estimated_currency_cost_per_new_observation: Option<f64>,
    pub response_preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrefixCacheArmSummary {
    pub arm: String,
    /// Warmup is excluded from all totals so the report compares steady-state
    /// layout behavior rather than cache creation order.
    pub measured_requests: usize,
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub cache_write_input_tokens: u64,
    pub uncached_input_tokens: u64,
    pub output_tokens: u64,
    pub cache_hit_rate: Option<f64>,
    pub weighted_token_cost: Option<f64>,
    pub estimated_currency_cost: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrefixCacheEvalReport {
    pub model: String,
    pub generated_at: String,
    pub history_chars: usize,
    pub observations: usize,
    pub cached_input_discount: f64,
    pub cache_write_input_multiplier: f64,
    pub output_input_multiplier: f64,
    pub prices_per_million: Option<TokenPrices>,
    pub steps: Vec<PrefixCacheStepReport>,
    pub summaries: Vec<PrefixCacheArmSummary>,
}

pub async fn run_context_prefix_cache_eval(
    output_dir: &Path,
    mut config: PrefixCacheEvalConfig,
) -> Result<PrefixCacheEvalReport, EvalError> {
    std::fs::create_dir_all(output_dir)?;
    let (client, model, app_config) = configured_model_client_with_config()?;
    if config.prices_per_million.is_none() {
        config.prices_per_million = configured_prices(&app_config, &model);
    }
    if let Err(error) = client.set_reasoning_effort(Some(ReasoningEffort::Off)) {
        eprintln!(
            "cache eval: provider does not support reasoning=off ({error}); using configured value"
        );
    }
    let stable_system = format!(
        "{}\n\nPrefix-cache evaluation. Return only OK and do not call tools.",
        production_system_prompt()?
    );
    let history = synthetic_observations(config.observations, config.history_chars);
    let scenarios = [
        Scenario::Warm,
        Scenario::AppendOne,
        Scenario::AppendTwo,
        Scenario::MindRevision,
        Scenario::RetireOldestQuarter,
        Scenario::AppendAfterRetireOne,
        Scenario::AppendAfterRetireTwo,
        Scenario::AppendAfterRetireThree,
    ];
    let mut steps = Vec::new();

    for arm in [LayoutArm::Current, LayoutArm::InboxFirst] {
        let mut previous_serialized = None::<String>;
        for scenario in scenarios {
            let context = render_synthetic_context(arm, scenario, &history);
            let active_context_chars = context.chars().count();
            let user_message = Message {
                role: "user".to_string(),
                content: context,
                name: None,
                tool_call_id: None,
                tool_calls: None,
            };
            let messages = vec![
                Message {
                    role: "system".to_string(),
                    content: stable_system.clone(),
                    name: None,
                    tool_call_id: None,
                    tool_calls: None,
                },
                user_message.clone(),
            ];
            let active_context_measurement = client
                .count_prompt_tokens(
                    &format!("prefix-cache-eval-context-{}", arm.as_str()),
                    &[user_message],
                    &[],
                )
                .await?;
            let full_prompt_measurement = client
                .count_prompt_tokens(
                    &format!("prefix-cache-eval-full-{}", arm.as_str()),
                    &messages,
                    &[],
                )
                .await?;
            let serialized = serde_json::to_string(&messages)?;
            let common_prefix_chars = previous_serialized
                .as_deref()
                .map(|previous| common_prefix_chars(previous, &serialized))
                .unwrap_or(0);
            let structural_prefix_ratio = if serialized.is_empty() {
                0.0
            } else {
                common_prefix_chars as f64 / serialized.chars().count() as f64
            };
            let (response, usage) =
                request_with_usage(client.as_ref(), messages, full_prompt_measurement.clone())
                    .await?;
            let input_tokens = normalized_input_tokens(&usage);
            let uncached_input_tokens = normalized_uncached_input_tokens(&usage, input_tokens);
            let cache_hit_rate = input_tokens.filter(|total| *total > 0).and_then(|total| {
                usage
                    .cached_input_tokens
                    .map(|cached| cached as f64 / total as f64)
            });
            let weighted_token_cost = weighted_cost(
                uncached_input_tokens,
                usage.cached_input_tokens,
                usage.cache_write_input_tokens,
                usage.output_tokens,
                config.cached_input_discount,
                config.cache_write_input_multiplier,
                config.output_input_multiplier,
            );
            let estimated_currency_cost = config.prices_per_million.as_ref().and_then(|prices| {
                currency_cost(
                    uncached_input_tokens,
                    usage.cached_input_tokens,
                    usage.cache_write_input_tokens,
                    usage.output_tokens,
                    prices,
                )
            });
            let new_observations = scenario.new_observations();
            steps.push(PrefixCacheStepReport {
                arm: arm.as_str().to_string(),
                scenario: scenario.as_str().to_string(),
                warmup: scenario.is_warmup(),
                request_chars: serialized.chars().count(),
                active_context_chars,
                active_context_estimated_tokens: active_context_measurement
                    .as_ref()
                    .map(|measurement| measurement.tokens),
                active_context_estimate_source: active_context_measurement
                    .as_ref()
                    .map(measurement_label),
                full_prompt_estimated_tokens: full_prompt_measurement
                    .as_ref()
                    .map(|measurement| measurement.tokens),
                full_prompt_estimate_source: full_prompt_measurement
                    .as_ref()
                    .map(measurement_label),
                common_prefix_chars,
                structural_prefix_ratio,
                new_observations,
                input_tokens,
                cached_input_tokens: usage.cached_input_tokens,
                cache_write_input_tokens: usage.cache_write_input_tokens,
                uncached_input_tokens,
                output_tokens: usage.output_tokens,
                cache_hit_rate,
                weighted_token_cost,
                weighted_cost_per_new_observation: per_new_observation(
                    weighted_token_cost,
                    new_observations,
                ),
                estimated_currency_cost,
                estimated_currency_cost_per_new_observation: per_new_observation(
                    estimated_currency_cost,
                    new_observations,
                ),
                response_preview: response.content.chars().take(160).collect(),
            });
            previous_serialized = Some(serialized);
        }
    }

    let summaries = [LayoutArm::Current, LayoutArm::InboxFirst]
        .into_iter()
        .map(|arm| summarize_arm(arm, &steps))
        .collect();
    let report = PrefixCacheEvalReport {
        model,
        generated_at: chrono::Utc::now().to_rfc3339(),
        history_chars: config.history_chars,
        observations: config.observations,
        cached_input_discount: config.cached_input_discount,
        cache_write_input_multiplier: config.cache_write_input_multiplier,
        output_input_multiplier: config.output_input_multiplier,
        prices_per_million: config.prices_per_million,
        steps,
        summaries,
    };
    std::fs::write(
        output_dir.join("report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(report)
}

async fn request_with_usage(
    client: &dyn morphz::llm::Client,
    messages: Vec<Message>,
    measurement: Option<PromptTokenCount>,
) -> Result<(morphz::llm::Response, ModelUsage), EvalError> {
    let (stream, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let response = client
        .create_completion_measured_stream(messages, Vec::new(), measurement, stream)
        .await?;
    let mut usage = ModelUsage::default();
    while let Some(event) = receiver.recv().await {
        if let ModelStreamEvent::Usage { usage: newer } = event {
            usage.merge_from(&newer);
        }
    }
    Ok((response, usage))
}

fn configured_prices(config: &AppConfig, model: &str) -> Option<TokenPrices> {
    let price = config.usage_pricing.models.get(model)?;
    prices_from_config(&config.usage_pricing.currency, price)
}

fn prices_from_config(currency: &str, price: &ModelUsagePrice) -> Option<TokenPrices> {
    if currency.trim().is_empty() || price.version.trim().is_empty() {
        return None;
    }
    Some(TokenPrices {
        currency: currency.to_string(),
        version: price.version.clone(),
        uncached_input: price.input_per_million?,
        cached_input: price.cached_input_per_million?,
        cache_write_input: price.cache_write_input_per_million,
        output: price.output_per_million?,
    })
}

fn synthetic_observations(count: usize, target_chars: usize) -> Vec<String> {
    let per_observation = target_chars.saturating_div(count.max(1)).max(48);
    (0..count)
        .map(|index| {
            let prefix = format!(
                "(observation (ref @e{}) (seq {}) (turn {}) (kind chat/user_message) (preview ",
                index + 1,
                index + 1,
                index / 3 + 1
            );
            let fill_len = per_observation.saturating_sub(prefix.chars().count() + 3);
            format!("{prefix}\"{}\"))", "历史证据".repeat(fill_len / 4 + 1))
        })
        .collect()
}

fn render_synthetic_context(arm: LayoutArm, scenario: Scenario, history: &[String]) -> String {
    let retire_count = match scenario {
        Scenario::RetireOldestQuarter
        | Scenario::AppendAfterRetireOne
        | Scenario::AppendAfterRetireTwo
        | Scenario::AppendAfterRetireThree => history.len() / 4,
        _ => 0,
    };
    let mut observations = history[retire_count..].to_vec();
    let appended = match scenario {
        Scenario::Warm => 0,
        Scenario::AppendOne => 1,
        Scenario::AppendTwo | Scenario::MindRevision | Scenario::RetireOldestQuarter => 2,
        Scenario::AppendAfterRetireOne => 3,
        Scenario::AppendAfterRetireTwo => 4,
        Scenario::AppendAfterRetireThree => 5,
    };
    for offset in 0..appended {
        let seq = history.len() + offset + 1;
        observations.push(format!(
            "(observation (ref @e{seq}) (seq {seq}) (turn 999) (kind chat/user_message) (preview \"新输入 {seq}\"))"
        ));
    }
    let inbox = format!("(inbox {})", observations.join(" "));
    let mind_revision = if matches!(
        scenario,
        Scenario::MindRevision
            | Scenario::RetireOldestQuarter
            | Scenario::AppendAfterRetireOne
            | Scenario::AppendAfterRetireTwo
            | Scenario::AppendAfterRetireThree
    ) {
        18
    } else {
        17
    };
    let mind = format!(
        "(mind (frame (id stable-knowledge) (revision 11) (body \"长期知识\")) (frame (id active-plan) (revision {mind_revision}) (body \"当前计划\")))"
    );
    let turn = match scenario {
        Scenario::Warm => 1,
        Scenario::AppendOne => 2,
        Scenario::AppendTwo => 3,
        Scenario::MindRevision => 4,
        Scenario::RetireOldestQuarter => 5,
        Scenario::AppendAfterRetireOne => 6,
        Scenario::AppendAfterRetireTwo => 7,
        Scenario::AppendAfterRetireThree => 8,
    };
    let directory = format!(
        "(session-directory (session (id cache-eval) (last-activity 2026-07-26T00:00:{turn:02}Z)))"
    );
    let kernel = format!(
        "(kernel (context cache-eval) (active-session cache-eval) (version {turn}) (cognitive-clock (tick {turn})) (turn-control (attempt {turn})))"
    );
    let evaluate = format!(
        "(evaluate (root-input \"只返回 OK\") (runtime-nonce {turn}) (terminal \"return ordinary text\"))"
    );
    match arm {
        LayoutArm::Current => format!(
            "(context (protocol (version cache-eval-v1)) {mind} {directory} {kernel} {inbox} {evaluate})"
        ),
        LayoutArm::InboxFirst => format!(
            "(context (protocol (version cache-eval-v1)) (evaluation-profile none) {inbox} (observation-state) {mind} {directory} {kernel} (evaluation-environment) {evaluate})"
        ),
    }
}

fn common_prefix_chars(left: &str, right: &str) -> usize {
    left.chars()
        .zip(right.chars())
        .take_while(|(left, right)| left == right)
        .count()
}

fn normalized_input_tokens(usage: &ModelUsage) -> Option<u64> {
    usage.input_tokens.or_else(|| {
        let values = [
            usage.uncached_input_tokens,
            usage.cached_input_tokens,
            usage.cache_write_input_tokens,
        ];
        values
            .iter()
            .any(Option::is_some)
            .then(|| values.into_iter().flatten().sum())
    })
}

fn normalized_uncached_input_tokens(usage: &ModelUsage, input: Option<u64>) -> Option<u64> {
    usage.uncached_input_tokens.or_else(|| {
        input.map(|total| {
            total
                .saturating_sub(usage.cached_input_tokens.unwrap_or(0))
                .saturating_sub(usage.cache_write_input_tokens.unwrap_or(0))
        })
    })
}

fn weighted_cost(
    uncached: Option<u64>,
    cached: Option<u64>,
    cache_write: Option<u64>,
    output: Option<u64>,
    cached_discount: f64,
    cache_write_multiplier: f64,
    output_multiplier: f64,
) -> Option<f64> {
    Some(
        uncached? as f64
            + cached.unwrap_or(0) as f64 * cached_discount
            + cache_write.unwrap_or(0) as f64 * cache_write_multiplier
            + output.unwrap_or(0) as f64 * output_multiplier,
    )
}

fn currency_cost(
    uncached: Option<u64>,
    cached: Option<u64>,
    cache_write: Option<u64>,
    output: Option<u64>,
    prices: &TokenPrices,
) -> Option<f64> {
    let cache_write_cost = match (cache_write.unwrap_or(0), prices.cache_write_input) {
        (0, _) => 0.0,
        (_, Some(rate)) => cache_write? as f64 * rate,
        (_, None) => return None,
    };
    Some(
        (uncached? as f64 * prices.uncached_input
            + cached.unwrap_or(0) as f64 * prices.cached_input
            + cache_write_cost
            + output.unwrap_or(0) as f64 * prices.output)
            / 1_000_000.0,
    )
}

fn per_new_observation(value: Option<f64>, new_observations: usize) -> Option<f64> {
    if new_observations == 0 {
        None
    } else {
        value.map(|value| value / new_observations as f64)
    }
}

fn measurement_label(measurement: &PromptTokenCount) -> String {
    format!("{}:{}", measurement.source, measurement.accuracy.as_str())
}

fn summarize_arm(arm: LayoutArm, steps: &[PrefixCacheStepReport]) -> PrefixCacheArmSummary {
    let selected = steps
        .iter()
        .filter(|step| step.arm == arm.as_str() && !step.warmup);
    let mut summary = PrefixCacheArmSummary {
        arm: arm.as_str().to_string(),
        measured_requests: 0,
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        uncached_input_tokens: 0,
        output_tokens: 0,
        cache_hit_rate: None,
        weighted_token_cost: Some(0.0),
        estimated_currency_cost: Some(0.0),
    };
    for step in selected {
        summary.measured_requests += 1;
        summary.input_tokens = summary
            .input_tokens
            .saturating_add(step.input_tokens.unwrap_or(0));
        summary.cached_input_tokens = summary
            .cached_input_tokens
            .saturating_add(step.cached_input_tokens.unwrap_or(0));
        summary.cache_write_input_tokens = summary
            .cache_write_input_tokens
            .saturating_add(step.cache_write_input_tokens.unwrap_or(0));
        summary.uncached_input_tokens = summary
            .uncached_input_tokens
            .saturating_add(step.uncached_input_tokens.unwrap_or(0));
        summary.output_tokens = summary
            .output_tokens
            .saturating_add(step.output_tokens.unwrap_or(0));
        summary.weighted_token_cost =
            sum_optional(summary.weighted_token_cost, step.weighted_token_cost);
        summary.estimated_currency_cost = sum_optional(
            summary.estimated_currency_cost,
            step.estimated_currency_cost,
        );
    }
    if summary.input_tokens > 0 {
        summary.cache_hit_rate =
            Some(summary.cached_input_tokens as f64 / summary.input_tokens as f64);
    }
    summary
}

fn sum_optional(total: Option<f64>, value: Option<f64>) -> Option<f64> {
    total.zip(value).map(|(total, value)| total + value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inbox_first_preserves_history_across_append() {
        let history = synthetic_observations(30, 12_000);
        let current_before = render_synthetic_context(LayoutArm::Current, Scenario::Warm, &history);
        let current_after =
            render_synthetic_context(LayoutArm::Current, Scenario::AppendOne, &history);
        let candidate_before =
            render_synthetic_context(LayoutArm::InboxFirst, Scenario::Warm, &history);
        let candidate_after =
            render_synthetic_context(LayoutArm::InboxFirst, Scenario::AppendOne, &history);
        let current_prefix = common_prefix_chars(&current_before, &current_after);
        let candidate_prefix = common_prefix_chars(&candidate_before, &candidate_after);
        assert!(candidate_prefix > current_prefix + 8_000);
    }

    #[test]
    fn retire_shrinks_the_active_request() {
        let history = synthetic_observations(40, 16_000);
        let before =
            render_synthetic_context(LayoutArm::InboxFirst, Scenario::MindRevision, &history);
        let after = render_synthetic_context(
            LayoutArm::InboxFirst,
            Scenario::RetireOldestQuarter,
            &history,
        );
        assert!(after.len() < before.len());
    }

    #[test]
    fn steady_state_summary_excludes_warmup() {
        let steps = vec![
            PrefixCacheStepReport {
                arm: "current".to_string(),
                scenario: "warm".to_string(),
                warmup: true,
                request_chars: 0,
                active_context_chars: 0,
                active_context_estimated_tokens: None,
                active_context_estimate_source: None,
                full_prompt_estimated_tokens: None,
                full_prompt_estimate_source: None,
                common_prefix_chars: 0,
                structural_prefix_ratio: 0.0,
                new_observations: 0,
                input_tokens: Some(100),
                cached_input_tokens: Some(0),
                cache_write_input_tokens: None,
                uncached_input_tokens: Some(100),
                output_tokens: Some(1),
                cache_hit_rate: Some(0.0),
                weighted_token_cost: Some(104.0),
                weighted_cost_per_new_observation: None,
                estimated_currency_cost: None,
                estimated_currency_cost_per_new_observation: None,
                response_preview: String::new(),
            },
            PrefixCacheStepReport {
                arm: "current".to_string(),
                scenario: "append-one".to_string(),
                warmup: false,
                request_chars: 0,
                active_context_chars: 0,
                active_context_estimated_tokens: None,
                active_context_estimate_source: None,
                full_prompt_estimated_tokens: None,
                full_prompt_estimate_source: None,
                common_prefix_chars: 0,
                structural_prefix_ratio: 0.0,
                new_observations: 1,
                input_tokens: Some(100),
                cached_input_tokens: Some(80),
                cache_write_input_tokens: None,
                uncached_input_tokens: Some(20),
                output_tokens: Some(1),
                cache_hit_rate: Some(0.8),
                weighted_token_cost: Some(32.0),
                weighted_cost_per_new_observation: Some(32.0),
                estimated_currency_cost: None,
                estimated_currency_cost_per_new_observation: None,
                response_preview: String::new(),
            },
        ];
        let summary = summarize_arm(LayoutArm::Current, &steps);
        assert_eq!(summary.measured_requests, 1);
        assert_eq!(summary.input_tokens, 100);
        assert_eq!(summary.cached_input_tokens, 80);
    }
}
