//! Shared task-scoped model controls. These never mutate Session or Runtime defaults.
use crate::llm::ReasoningEffort;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Runtime-owned physical-request evidence, not another settings authority.
/// Bounded fingerprints preserve nullable defaults without copying arbitrary
/// model names into recovery metadata. Explicit task fields never inherit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SessionEvaluationSnapshot {
    model_default_hash: String,
    reasoning_default_hash: String,
    pub(crate) inherits_model: bool,
    pub(crate) inherits_reasoning_effort: bool,
}

impl SessionEvaluationSnapshot {
    pub(crate) fn new(
        model: Option<&str>,
        effort: Option<&str>,
        inherits_model: bool,
        inherits_reasoning_effort: bool,
    ) -> Self {
        Self {
            model_default_hash: Self::hash(model),
            reasoning_default_hash: Self::hash(effort),
            inherits_model,
            inherits_reasoning_effort,
        }
    }

    fn hash(value: Option<&str>) -> String {
        let mut hash = Sha256::new();
        hash.update([u8::from(value.is_some())]);
        if let Some(value) = value {
            hash.update(value.as_bytes());
        }
        format!("{:x}", hash.finalize())
    }

    pub(crate) fn from_metadata(value: &serde_json::Value) -> Option<Self> {
        let snapshot: Self = serde_json::from_value(value.clone()).ok()?;
        let canonical = |hash: &str| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        };
        (canonical(&snapshot.model_default_hash) && canonical(&snapshot.reasoning_default_hash))
            .then_some(snapshot)
    }

    pub(crate) fn changed_from(&self, model: Option<&str>, effort: Option<&str>) -> bool {
        (self.inherits_model && self.model_default_hash != Self::hash(model))
            || (self.inherits_reasoning_effort && self.reasoning_default_hash != Self::hash(effort))
    }
}

#[derive(Debug)]
pub(crate) struct InvalidModelSelection(pub String);

impl std::fmt::Display for InvalidModelSelection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for InvalidModelSelection {}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelSelection {
    #[serde(
        default,
        alias = "model_alias",
        skip_serializing_if = "Option::is_none"
    )]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}

impl ModelSelection {
    pub fn normalize(&mut self) -> Result<(), String> {
        if let Some(model) = &mut self.model {
            *model = model.trim().to_string();
            if model.is_empty() {
                return Err("model must not be empty; omit it to inherit".into());
            }
        }
        if let Some(effort) = &mut self.reasoning_effort {
            *effort = if matches!(
                effort.trim().to_ascii_lowercase().as_str(),
                "provider_default" | "default" | "auto"
            ) {
                "provider_default".to_string()
            } else {
                ReasoningEffort::parse(effort)
                    .ok_or("reasoning_effort must be provider_default, none, low, medium, high, or max")?
                    .as_str()
                    .to_string()
            };
        }
        Ok(())
    }

    pub fn authorize(&mut self, allowed: &[String]) -> Result<(), String> {
        self.normalize()?;
        if let Some(model) = &self.model {
            if !allowed.contains(model) {
                return Err(format!("model route '{model}' is not authorized for the Agent by llm.allowed_evaluation_models"));
            }
        }
        Ok(())
    }
}

pub(crate) fn reasoning_effort_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "string",
        "enum": ["provider_default", "none", "low", "medium", "high", "max"],
        "description": "Task-scoped thinking depth; omit to inherit. provider_default explicitly uses the selected Provider/model default."
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_snapshot_compares_only_inherited_nullable_defaults() {
        for model in [None, Some(""), Some("none"), Some("old-model")] {
            for effort in [None, Some(""), Some("none"), Some("max")] {
                for inherits_model in [false, true] {
                    for inherits_effort in [false, true] {
                        let snapshot = SessionEvaluationSnapshot::new(
                            model,
                            effort,
                            inherits_model,
                            inherits_effort,
                        );
                        assert!(!snapshot.changed_from(model, effort));
                        assert_eq!(
                            snapshot.changed_from(Some("new-model"), effort),
                            inherits_model
                        );
                        assert_eq!(snapshot.changed_from(model, Some("low")), inherits_effort);
                        let encoded = serde_json::to_value(&snapshot).unwrap();
                        assert_eq!(
                            SessionEvaluationSnapshot::from_metadata(&encoded),
                            Some(snapshot)
                        );
                    }
                }
            }
        }
        assert_ne!(
            SessionEvaluationSnapshot::hash(None),
            SessionEvaluationSnapshot::hash(Some(""))
        );
        assert_ne!(
            SessionEvaluationSnapshot::hash(None),
            SessionEvaluationSnapshot::hash(Some("none"))
        );
    }

    #[test]
    fn session_snapshot_rejects_missing_partial_unknown_and_malformed_evidence() {
        let valid = serde_json::to_value(SessionEvaluationSnapshot::new(
            None,
            Some("max"),
            true,
            false,
        ))
        .unwrap();
        assert!(SessionEvaluationSnapshot::from_metadata(&serde_json::Value::Null).is_none());
        for key in [
            "model_default_hash",
            "reasoning_default_hash",
            "inherits_model",
            "inherits_reasoning_effort",
        ] {
            let mut missing = valid.clone();
            missing.as_object_mut().unwrap().remove(key);
            assert!(SessionEvaluationSnapshot::from_metadata(&missing).is_none());
            let mut wrong = valid.clone();
            wrong[key] = serde_json::Value::Null;
            assert!(SessionEvaluationSnapshot::from_metadata(&wrong).is_none());
        }
        for invalid in ["", "f", &"F".repeat(64), &"g".repeat(64), &"a".repeat(65)] {
            let mut wrong = valid.clone();
            wrong["model_default_hash"] = serde_json::json!(invalid);
            assert!(SessionEvaluationSnapshot::from_metadata(&wrong).is_none());
        }
        let mut unknown = valid;
        unknown["invented"] = serde_json::json!(true);
        assert!(SessionEvaluationSnapshot::from_metadata(&unknown).is_none());
    }

    #[test]
    fn task_model_controls_are_optional_normalized_and_fail_closed() {
        assert_eq!(
            serde_json::from_str::<ModelSelection>("{}").unwrap(),
            ModelSelection::default()
        );
        for (input, expected) in [
            ("off", "none"),
            ("maximum", "max"),
            ("HIGH", "high"),
            ("default", "provider_default"),
        ] {
            let mut choice = ModelSelection {
                model: Some(" task-route ".into()),
                reasoning_effort: Some(input.into()),
            };
            choice.authorize(&["task-route".into()]).unwrap();
            assert_eq!(choice.model.as_deref(), Some("task-route"));
            assert_eq!(choice.reasoning_effort.as_deref(), Some(expected));
        }
        for value in ["", "turbo", "false"] {
            let mut choice = ModelSelection {
                model: None,
                reasoning_effort: Some(value.into()),
            };
            assert!(choice.normalize().is_err());
        }
        let mut choice = ModelSelection {
            model: Some("not-authorized".into()),
            reasoning_effort: None,
        };
        assert!(choice.authorize(&["task-route".into()]).is_err());
    }
}
