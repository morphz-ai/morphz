//! Shared task-scoped model controls. These never mutate Session or Runtime defaults.
use crate::llm::ReasoningEffort;
use serde::{Deserialize, Serialize};

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
