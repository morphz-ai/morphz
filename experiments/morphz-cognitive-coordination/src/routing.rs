use crate::error::{CoordinationError, CoordinationResult};
use crate::model::{CognitiveEvaluationRequest, ParticipantDescriptor, RoutingRejection};

#[derive(Debug, Clone)]
pub struct RoutingSelection {
    pub selected: Vec<ParticipantDescriptor>,
    pub rejected: Vec<RoutingRejection>,
    pub total_token_budget: u64,
    pub algorithm: String,
}

pub trait ParticipantRouter: Send + Sync {
    fn select(
        &self,
        request: &CognitiveEvaluationRequest,
        participants: &[ParticipantDescriptor],
    ) -> CoordinationResult<RoutingSelection>;
}

/// Deterministic sparse selector for the local experiment.
///
/// Eligibility is a hard boundary. Preferred capability count and explicit
/// priority only rank already-eligible participants; stable Authority identity
/// breaks ties so replay produces the same plan.
#[derive(Debug, Default)]
pub struct CapabilityRouter;

impl ParticipantRouter for CapabilityRouter {
    fn select(
        &self,
        request: &CognitiveEvaluationRequest,
        participants: &[ParticipantDescriptor],
    ) -> CoordinationResult<RoutingSelection> {
        request.validate()?;
        let constraints = &request.routing;
        let mut ranked = Vec::new();
        let mut rejected = Vec::new();

        for participant in participants {
            let rejection = if !participant.enabled {
                Some("participant is disabled".to_string())
            } else if !constraints.allowed_authority_ids.is_empty()
                && !constraints
                    .allowed_authority_ids
                    .contains(&participant.authority_id)
            {
                Some("authority is outside the request allowlist".to_string())
            } else if !constraints
                .required_capabilities
                .is_subset(&participant.capabilities)
            {
                let missing = constraints
                    .required_capabilities
                    .difference(&participant.capabilities)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ");
                Some(format!("missing required capabilities: {missing}"))
            } else if participant.max_token_budget < constraints.token_budget_per_participant {
                Some(format!(
                    "participant token capacity {} is below required assignment budget {}",
                    participant.max_token_budget, constraints.token_budget_per_participant
                ))
            } else {
                model_rejection(
                    participant,
                    constraints.model_for(&participant.authority_id),
                )
            };

            if let Some(reason) = rejection {
                rejected.push(RoutingRejection {
                    authority_id: participant.authority_id.clone(),
                    reason,
                });
                continue;
            }

            let preferred_matches = constraints
                .preferred_capabilities
                .intersection(&participant.capabilities)
                .count();
            ranked.push((preferred_matches, participant.clone()));
        }

        ranked.sort_by(|(left_matches, left), (right_matches, right)| {
            right_matches
                .cmp(left_matches)
                .then_with(|| right.priority.cmp(&left.priority))
                .then_with(|| left.authority_id.cmp(&right.authority_id))
                .then_with(|| left.agent_id.cmp(&right.agent_id))
        });

        let budget_limited_max = usize::try_from(
            constraints.max_total_token_budget / constraints.token_budget_per_participant,
        )
        .unwrap_or(usize::MAX);
        let selection_limit = constraints.max_participants.min(budget_limited_max);
        let mut selected = Vec::new();
        for (_, participant) in ranked {
            if selected.len() >= selection_limit {
                rejected.push(RoutingRejection {
                    authority_id: participant.authority_id,
                    reason: "sparse selection limit reached".to_string(),
                });
            } else {
                selected.push(participant);
            }
        }

        if selected.len() < constraints.min_participants {
            return Err(CoordinationError::Routing(format!(
                "request requires at least {} eligible participants, but only {} were selected",
                constraints.min_participants,
                selected.len()
            )));
        }
        let total_token_budget = constraints
            .token_budget_per_participant
            .checked_mul(selected.len() as u64)
            .ok_or_else(|| CoordinationError::Routing("selected token budget overflowed".into()))?;
        rejected.sort_by(|left, right| left.authority_id.cmp(&right.authority_id));

        Ok(RoutingSelection {
            selected,
            rejected,
            total_token_budget,
            algorithm: "capability-top-k-v0".to_string(),
        })
    }
}

fn model_rejection(
    participant: &ParticipantDescriptor,
    request: &crate::model::EvaluationModelRequest,
) -> Option<String> {
    participant
        .resolve_model(request)
        .err()
        .map(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{CapabilityRouter, ParticipantRouter};
    use crate::model::{
        CognitiveEvaluationRequest, ParticipantDescriptor, RoutingConstraints, SettlementPolicyRef,
    };
    use crate::EXPERIMENT_SPEC_VERSION;
    use serde_json::Value;
    use std::collections::BTreeSet;

    fn participant(id: &str, capabilities: &[&str], priority: i32) -> ParticipantDescriptor {
        ParticipantDescriptor {
            authority_id: format!("authority-{id}"),
            agent_id: format!("agent-{id}"),
            context_id: format!("context-{id}"),
            session_id: format!("session-{id}"),
            capabilities: capabilities.iter().map(|value| value.to_string()).collect(),
            model_profiles: Vec::new(),
            default_model: Default::default(),
            max_token_budget: 1_000,
            priority,
            enabled: true,
        }
    }

    fn request() -> CognitiveEvaluationRequest {
        CognitiveEvaluationRequest {
            spec_version: EXPERIMENT_SPEC_VERSION.to_string(),
            request_id: "request-1".to_string(),
            objective_id: "objective-1".to_string(),
            initiator_authority_id: "initiator".to_string(),
            commit_target: None,
            question: "question".to_string(),
            shared_input: Value::Null,
            routing: RoutingConstraints {
                min_participants: 2,
                max_participants: 2,
                token_budget_per_participant: 500,
                max_total_token_budget: 1_000,
                required_capabilities: BTreeSet::from(["reasoning".to_string()]),
                preferred_capabilities: BTreeSet::from(["review".to_string()]),
                allowed_authority_ids: BTreeSet::new(),
                model: Default::default(),
                participant_models: Vec::new(),
            },
            settlement_policy: SettlementPolicyRef {
                id: "preserve-alternatives".to_string(),
                version: "0".to_string(),
            },
        }
    }

    #[test]
    fn routing_is_sparse_capability_bounded_and_deterministic() {
        let participants = vec![
            participant("a", &["reasoning"], 100),
            participant("b", &["reasoning", "review"], 0),
            participant("c", &["reasoning"], 10),
            participant("d", &["review"], 1000),
        ];
        let selection = CapabilityRouter.select(&request(), &participants).unwrap();
        let ids = selection
            .selected
            .iter()
            .map(|participant| participant.authority_id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["authority-b", "authority-a"]);
        assert_eq!(selection.total_token_budget, 1_000);
        assert!(selection.rejected.iter().any(|rejection| {
            rejection.authority_id == "authority-d"
                && rejection.reason.contains("missing required capabilities")
        }));
    }
}
