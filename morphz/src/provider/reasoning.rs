//! Physical endpoint capabilities, independent of a task's chosen effort.
use crate::config::{ModelProtocol, ProviderModelConfig};
use crate::llm::ReasoningEffort;

/// Explicit endpoint metadata wins over the documented physical-model floor.
/// Unknown endpoints retain the pre-existing vocabulary, but never advertise
/// xhigh without evidence. No remote discovery or model call happens here.
pub(crate) fn model_reasoning_efforts(
    adapter: &str,
    protocol: ModelProtocol,
    model: &str,
    profile: Option<&ProviderModelConfig>,
) -> Option<Vec<ReasoningEffort>> {
    if let Some(levels) = profile.and_then(|profile| profile.supported_reasoning_efforts.as_ref()) {
        return Some(
            ReasoningEffort::ALL
                .into_iter()
                .filter(|level| levels.contains(level))
                .collect(),
        );
    }
    if !matches!(
        protocol,
        ModelProtocol::OpenaiChat | ModelProtocol::OpenaiResponses
    ) {
        return None;
    }
    let model = model.trim().to_ascii_lowercase();
    use ReasoningEffort::{High, Low, Max, Medium, Off, XHigh};
    // Exact published model IDs and their dated snapshots, never route labels.
    // Sources and review date: docs/runtime_reasoning_efforts.md.
    let is = |name: &str| {
        model == name
            || model
                .strip_prefix(name)
                .and_then(|s| s.strip_prefix('-'))
                .is_some_and(|s| {
                    s.len() == 10
                        && s.bytes().enumerate().all(|(i, b)| {
                            if i == 4 || i == 7 {
                                b == b'-'
                            } else {
                                b.is_ascii_digit()
                            }
                        })
                })
    };
    if ["gpt-6-astra", "gpt-6.1-sol"].iter().any(|name| is(name)) {
        return Some(vec![Low, Medium, High, XHigh, Max]);
    }
    if [
        "gpt-6-sol",
        "gpt-6-luna",
        "gpt-6.1-terra",
        "gpt-5.6",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
    ]
    .iter()
    .any(|name| is(name))
    {
        return Some(vec![Off, Low, Medium, High, XHigh, Max]);
    }
    if ["gpt-5.2", "gpt-5.4", "gpt-5.5"]
        .iter()
        .any(|name| is(name))
    {
        return Some(vec![Off, Low, Medium, High, XHigh]);
    }
    if ["gpt-5.2-codex", "gpt-5.3-codex"]
        .iter()
        .any(|name| is(name))
    {
        return Some(vec![Low, Medium, High, XHigh]);
    }
    if ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro"]
        .iter()
        .any(|name| is(name))
    {
        // DeepSeek accepts xhigh only as an alias of high, not a distinct level.
        return Some(vec![Off, Low, High, Max]);
    }
    super::supported_reasoning_efforts_for_model(adapter, &model).map(<[_]>::to_vec)
}

/// A failover route can offer only levels common to every physical candidate.
/// An unknown candidate cannot certify the newly added xhigh level.
pub(crate) fn common_reasoning_efforts(
    capabilities: &[Option<Vec<ReasoningEffort>>],
) -> Option<Vec<String>> {
    if capabilities.is_empty() || capabilities.iter().all(Option::is_none) {
        return None;
    }
    Some(
        ReasoningEffort::ALL
            .into_iter()
            .filter(|level| {
                capabilities.iter().all(|supported| match supported {
                    Some(levels) => levels.contains(level),
                    None => *level != ReasoningEffort::XHigh,
                })
            })
            .map(|effort| effort.as_str().to_string())
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reasoning_metadata_is_explicit_and_roundtrips_without_changing_capacity() {
        let profile = super::super::discovered_model_profile(
            &serde_json::json!({
                "id":"custom-physical", "context_window":200000,
                "supported_reasoning_levels":[{"effort":"high"},{"effort":"xhigh"}],
            }),
            ModelProtocol::OpenaiResponses,
        );
        assert_eq!(
            profile.supported_reasoning_efforts,
            Some(vec![ReasoningEffort::High, ReasoningEffort::XHigh])
        );
        assert_eq!(profile.context_window_tokens, Some(200000));
        let encoded = serde_json::to_value(&profile).unwrap();
        assert_eq!(
            serde_json::from_value::<ProviderModelConfig>(encoded).unwrap(),
            profile
        );
        let unspecified = super::super::discovered_model_profile(
            &serde_json::json!({"id":"custom-physical"}),
            ModelProtocol::OpenaiResponses,
        );
        assert_eq!(unspecified.supported_reasoning_efforts, None);
        assert!(!serde_json::to_value(unspecified)
            .unwrap()
            .as_object()
            .unwrap()
            .contains_key("supported_reasoning_efforts"));
    }
    fn levels(model: &str) -> Option<Vec<ReasoningEffort>> {
        model_reasoning_efforts(
            "openai-compatible",
            ModelProtocol::OpenaiResponses,
            model,
            None,
        )
    }
    #[test]
    fn reasoning_capabilities_are_physical_model_specific() {
        use ReasoningEffort::*;
        assert_eq!(
            levels("gpt-6.1-sol"),
            Some(vec![Low, Medium, High, XHigh, Max])
        );
        assert_eq!(
            levels("gpt-5.5-2026-04-23"),
            Some(vec![Off, Low, Medium, High, XHigh])
        );
        assert_eq!(
            levels("gpt-5.3-codex"),
            Some(vec![Low, Medium, High, XHigh])
        );
        assert_eq!(levels("deepseek-flash"), Some(vec![Off, Low, High, Max]));
        assert_eq!(levels("gpt-6.1-sol-custom-proxy"), None);
        assert_eq!(levels("unrecognized-model"), None);
        assert_eq!(
            model_reasoning_efforts(
                "anthropic",
                ModelProtocol::AnthropicMessages,
                "gpt-6.1-sol",
                None
            ),
            None
        );
    }
    #[test]
    fn reasoning_declaration_wins_and_route_intersection_preserves_unknown_boundary() {
        use ReasoningEffort::*;
        let profile = ProviderModelConfig {
            supported_reasoning_efforts: Some(vec![XHigh, Low, XHigh]),
            ..Default::default()
        };
        assert_eq!(
            model_reasoning_efforts(
                "custom",
                ModelProtocol::OpenaiChat,
                "custom-model",
                Some(&profile)
            ),
            Some(vec![Low, XHigh])
        );
        assert_eq!(
            common_reasoning_efforts(&[levels("gpt-6.1-sol"), levels("gpt-5.3-codex")]),
            Some(vec![
                "low".into(),
                "medium".into(),
                "high".into(),
                "xhigh".into()
            ])
        );
        assert_eq!(
            common_reasoning_efforts(&[levels("gpt-6.1-sol"), None]),
            Some(vec![
                "low".into(),
                "medium".into(),
                "high".into(),
                "max".into()
            ])
        );
        assert_eq!(common_reasoning_efforts(&[None]), None);
        let profile = ProviderModelConfig {
            supported_reasoning_efforts: Some(vec![]),
            ..Default::default()
        };
        assert_eq!(
            model_reasoning_efforts(
                "custom",
                ModelProtocol::OpenaiResponses,
                "gpt-6.1-sol",
                Some(&profile)
            ),
            Some(vec![])
        );
    }
}
