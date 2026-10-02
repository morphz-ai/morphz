//! Authorized, bounded, read-only display projection. Immutable Events are
//! the source; this module never writes activity state or asks a model.
use super::{MorphzRuntime, RuntimeError, SchedulerThreadSnapshot};
use crate::event::{Event, TYPE_TOOL_OUTPUT};
use crate::memory::{QueryFilter, ThreadLifecycle, ThreadSignalStatus};
use crate::orchestrator::context::ContextViewManifest;
use crate::response_annotations::{
    annotations_from_authorized_event, project_execution, AnnotationKind, AnnotationRecord,
    ExecutionFact, ExecutionScope, Protocol,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

const SOURCE_LIMIT: usize = 128;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadStepAnnotation {
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadResponseAnnotations {
    pub protocol: Protocol,
    pub scope: ExecutionScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    pub steps: Vec<ThreadStepAnnotation>,
    pub source_count: usize,
    /// Tail sources are bounded. Incomplete history never pretends to know
    /// the first valid whole-task title; clients retain their original intent.
    pub truncated: bool,
}

fn text<'a>(event: &'a Event, key: &str) -> Option<&'a str> {
    event.payload.get(key).and_then(serde_json::Value::as_str)
}
fn routed(event: &Event, snapshot: &SchedulerThreadSnapshot) -> bool {
    let thread = &snapshot.thread;
    text(event, "context_id") == Some(thread.context_id.as_str())
        && text(event, "session_id") == Some(thread.session_id.as_str())
        && text(event, "thread_id") == Some(thread.id.as_str())
        && text(event, "root_turn_id") == Some(thread.root_turn_id.as_str())
        && event
            .payload
            .get("thread_generation")
            .and_then(serde_json::Value::as_u64)
            == Some(thread.generation)
        && text(event, "principal_id") == thread.initiating_principal_id.as_deref()
}

/// An immutable physical Job can outlive a rejected replay with the same
/// call ID. Match the complete business arguments, not just that ID. Only
/// the top-level annotation carrier and known Runtime route fields differ.
fn intent_arguments_match(
    source_arguments: &str,
    job_request: &serde_json::Value,
    job_target_id: &str,
) -> bool {
    let Ok(mut source) = serde_json::from_str::<serde_json::Value>(source_arguments) else {
        return false;
    };
    let Some(object) = source.as_object_mut() else {
        return false;
    };
    object.remove("_annotations");
    let Ok(encoded) = serde_json::to_string(&source) else {
        return false;
    };
    let Ok(invocation) = crate::execution_target::split_target_argument(&encoded) else {
        return false;
    };
    if invocation.explicit_target && invocation.target_id != job_target_id {
        return false;
    }
    let Ok(business) = serde_json::from_str::<serde_json::Value>(&invocation.tool_arguments) else {
        return false;
    };
    let mut actual = job_request.clone();
    let Some(object) = actual.as_object_mut() else {
        return false;
    };
    for key in [
        crate::execution_target::EXECUTION_ROUTE_REQUEST_KEY,
        crate::execution_target::ARTIFACT_TRANSFER_ROUTES_REQUEST_KEY,
        crate::approval::CAPABILITY_LEASE_OBJECTIVE_REQUEST_KEY,
        "_morphz_action_group_id",
        "_morphz_wake_thread",
    ] {
        object.remove(key);
    }
    business == actual
}

impl MorphzRuntime {
    pub(super) async fn attach_response_annotations(
        &self,
        context_id: &str,
        snapshots: &mut [SchedulerThreadSnapshot],
    ) -> Result<(), RuntimeError> {
        let ids = snapshots
            .iter()
            .filter(|snapshot| {
                !snapshot.thread.response_annotations.is_off()
                    && snapshot.thread.context_id == context_id
                    && snapshot.thread.executor_kind != "plan_infer"
            })
            .map(|snapshot| snapshot.thread.id.clone())
            .collect::<Vec<_>>();
        if ids.is_empty() {
            return Ok(());
        }
        let Some(context) = self.inner.store.get_context(context_id).await? else {
            return Ok(());
        };
        let sources = self
            .inner
            .store
            .list_thread_annotation_sources(context_id, &ids, SOURCE_LIMIT + 1)
            .await?;
        let activation_ids = sources
            .iter()
            .filter_map(|event| text(event, "activation_id").map(str::to_string))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let activations = self
            .inner
            .store
            .list_thread_activations_by_ids(context_id, &activation_ids)
            .await?
            .into_iter()
            .map(|activation| (activation.id.clone(), activation))
            .collect::<HashMap<_, _>>();
        let mut revision_event_ids = HashSet::new();
        let mut evidence_ids = HashSet::new();
        for source in &sources {
            let Some(thread_id) = text(source, "thread_id") else {
                continue;
            };
            let Some(snapshot) = snapshots.iter().find(|s| s.thread.id == thread_id) else {
                continue;
            };
            let scope = ExecutionScope {
                execution_id: thread_id.into(),
                generation: snapshot.thread.generation,
            };
            if let Ok(Some(bundle)) = annotations_from_authorized_event(source, &scope) {
                if bundle.protocol != snapshot.thread.response_annotations {
                    continue;
                }
                if let Some(revision) = &bundle.title_input_revision {
                    evidence_ids.insert(revision.event_id.clone());
                    revision_event_ids.insert(revision.event_id.clone());
                }
                evidence_ids.extend(
                    bundle
                        .records
                        .iter()
                        .filter_map(|record| record.observation_event_id.clone()),
                );
            }
        }
        let mut signals = Vec::new();
        for chunk in revision_event_ids
            .into_iter()
            .collect::<Vec<_>>()
            .chunks(256)
        {
            signals.extend(
                self.inner
                    .store
                    .list_annotation_revision_signals(context_id, &ids, chunk)
                    .await?,
            );
        }
        let mut evidence = HashMap::new();
        // Bound SQL bind counts even when the Scheduler selects many Threads.
        for chunk in evidence_ids.into_iter().collect::<Vec<_>>().chunks(256) {
            for event in self
                .inner
                .store
                .query(QueryFilter {
                    context_id: Some(context_id.into()),
                    event_ids: chunk.to_vec(),
                    ..Default::default()
                })
                .await?
            {
                evidence.insert(event.id.clone(), event);
            }
        }
        let mut by_thread = HashMap::<String, Vec<Event>>::new();
        for source in sources {
            if let Some(id) = text(&source, "thread_id") {
                by_thread.entry(id.into()).or_default().push(source);
            }
        }
        let mut sessions = HashMap::new();
        for snapshot in snapshots.iter_mut() {
            if !ids.contains(&snapshot.thread.id) {
                continue;
            }
            let thread = &snapshot.thread;
            if !sessions.contains_key(&thread.session_id) {
                sessions.insert(
                    thread.session_id.clone(),
                    self.inner.store.get_session(&thread.session_id).await?,
                );
            }
            let Some(session) = sessions.get(&thread.session_id).and_then(Option::as_ref) else {
                continue;
            };
            if session.context_id != thread.context_id
                || session.agent_id != thread.agent_id
                || context.agent_id != thread.agent_id
            {
                continue;
            }
            let scope = ExecutionScope {
                execution_id: thread.id.clone(),
                generation: thread.generation,
            };
            let mut thread_sources = by_thread.remove(&thread.id).unwrap_or_default();
            let truncated = thread_sources.len() > SOURCE_LIMIT;
            if truncated {
                thread_sources.remove(0);
            }
            let source_count = thread_sources.len();
            let terminal_sequence = snapshot
                .outcome
                .as_ref()
                .filter(|outcome| {
                    outcome.thread_id == thread.id
                        && outcome.thread_generation == thread.generation
                        && outcome.session_id == thread.session_id
                        && outcome.root_turn_id == thread.root_turn_id
                        && outcome.terminal_kind == thread.lifecycle
                })
                .and_then(|outcome| outcome.terminal_event_sequence);
            let mut records = Vec::<AnnotationRecord>::new();
            let mut steps = BTreeMap::<String, ThreadStepAnnotation>::new();
            for source in thread_sources {
                if terminal_sequence.is_some_and(|sequence| {
                    source
                        .sequence
                        .is_none_or(|source_sequence| source_sequence > sequence)
                }) {
                    continue;
                }
                if !routed(&source, snapshot) {
                    continue;
                }
                let Some(activation_id) = text(&source, "activation_id") else {
                    continue;
                };
                let Some(activation) = activations.get(activation_id) else {
                    continue;
                };
                if activation.agent_id != thread.agent_id
                    || activation.context_id != thread.context_id
                    || activation.session_id != thread.session_id
                    || activation.root_turn_id != thread.root_turn_id
                    || activation.generation != thread.generation
                    || activation.initiating_principal_id != thread.initiating_principal_id
                {
                    continue;
                }
                let Ok(Some(mut bundle)) = annotations_from_authorized_event(&source, &scope)
                else {
                    continue;
                };
                if bundle.protocol != thread.response_annotations {
                    continue;
                }
                let Some(manifest) =
                    source
                        .payload
                        .get("context_view_manifest")
                        .and_then(|value| {
                            serde_json::from_value::<ContextViewManifest>(value.clone()).ok()
                        })
                else {
                    continue;
                };
                if manifest.context_id != thread.context_id
                    || source
                        .sequence
                        .is_none_or(|sequence| manifest.event_sequence_upper_bound >= sequence)
                {
                    continue;
                }
                if let Some(revision) = &bundle.title_input_revision {
                    let valid = evidence.get(&revision.event_id).is_some_and(|event| {
                        event.topic == "chat/steering"
                            && routed(event, snapshot)
                            && event.sequence == Some(revision.sequence)
                            && revision.sequence <= manifest.event_sequence_upper_bound
                            && signals.iter().any(|signal| {
                                signal.thread_id == thread.id
                                    && signal.thread_generation == thread.generation
                                    && signal.event_id == event.id
                                    && signal.sequence == revision.sequence
                                    && signal.principal_id == thread.initiating_principal_id
                                    && signal.kind == "chat/steering"
                                    && signal.status != ThreadSignalStatus::Pending
                            })
                    });
                    if !valid {
                        bundle
                            .records
                            .retain(|record| record.kind != AnnotationKind::Title);
                    }
                } else if source
                    .payload
                    .get(crate::response_annotations::BUNDLE_PAYLOAD_KEY)
                    .and_then(|value| value.get("title_input_revision"))
                    .is_some_and(|value| !value.is_null())
                {
                    bundle
                        .records
                        .retain(|record| record.kind != AnnotationKind::Title);
                }
                for record in bundle.records {
                    let jobs = snapshot
                        .activations
                        .iter()
                        .flat_map(|activation| activation.jobs.iter())
                        .map(|s| &s.job);
                    match record.kind {
                        AnnotationKind::Intent => {
                            // A model attempt ID is not a physical Activation ID.
                            // Follow the actual source Event's route, never call_id alone.
                            if let Some(job) = jobs
                                .filter(|job| {
                                    job.thread_id == thread.id
                                        && job.agent_id == thread.agent_id
                                        && job.context_id == thread.context_id
                                        && job.session_id == thread.session_id
                                        && job.activation_id == activation_id
                                        && Some(job.tool_call_id.as_str())
                                            == record.call_id.as_deref()
                                })
                                .filter(|job| {
                                    source
                                        .payload
                                        .get("tool_calls")
                                        .and_then(serde_json::Value::as_array)
                                        .is_some_and(|calls| {
                                            calls.iter().any(|call| {
                                                call.get("id").and_then(serde_json::Value::as_str)
                                                    == Some(job.tool_call_id.as_str())
                                                    && call
                                                        .pointer("/function/name")
                                                        .and_then(serde_json::Value::as_str)
                                                        == Some(job.tool_name.as_str())
                                                    && call
                                                        .pointer("/function/arguments")
                                                        .and_then(serde_json::Value::as_str)
                                                        .is_some_and(|arguments| {
                                                            intent_arguments_match(
                                                                arguments,
                                                                &job.request,
                                                                &job.target_id,
                                                            )
                                                        })
                                            })
                                        })
                                })
                                .next()
                            {
                                steps
                                    .entry(job.id.clone())
                                    .or_insert_with(|| ThreadStepAnnotation {
                                        job_id: job.id.clone(),
                                        intent: None,
                                        result: None,
                                    })
                                    .intent = Some(record.value.clone());
                            }
                        }
                        AnnotationKind::ObservationResult => {
                            let receipt = record
                                .observation_event_id
                                .as_ref()
                                .and_then(|id| evidence.get(id));
                            if let Some(receipt) = receipt.filter(|event| {
                                event.event_type == TYPE_TOOL_OUTPUT
                                    && routed(event, snapshot)
                                    && event.sequence.is_some_and(|sequence| {
                                        sequence <= manifest.event_sequence_upper_bound
                                            && Some(sequence) < source.sequence
                                    })
                            }) {
                                if let Some(job) = jobs
                                    .filter(|job| {
                                        job.thread_id == thread.id
                                            && job.agent_id == thread.agent_id
                                            && job.context_id == thread.context_id
                                            && job.session_id == thread.session_id
                                            && job.status.is_terminal()
                                            && job.result_event_id.as_deref()
                                                == Some(receipt.id.as_str())
                                            && text(receipt, "activation_id")
                                                == Some(job.activation_id.as_str())
                                            && text(receipt, "tool_call_id")
                                                == Some(job.tool_call_id.as_str())
                                    })
                                    .next()
                                {
                                    steps
                                        .entry(job.id.clone())
                                        .or_insert_with(|| ThreadStepAnnotation {
                                            job_id: job.id.clone(),
                                            intent: None,
                                            result: None,
                                        })
                                        .result = Some(record.value.clone());
                                }
                            }
                        }
                        AnnotationKind::Result
                            if source.payload.get("terminal_outcome")
                                != Some(&serde_json::json!(true)) =>
                        {
                            continue
                        }
                        _ => (),
                    }
                    records.push(record);
                }
            }
            let outcome = snapshot.outcome.as_ref().filter(|outcome| {
                outcome.thread_id == thread.id
                    && outcome.thread_generation == thread.generation
                    && outcome.session_id == thread.session_id
                    && outcome.root_turn_id == thread.root_turn_id
                    && outcome.terminal_kind == thread.lifecycle
            });
            let fact = ExecutionFact {
                scope: scope.clone(),
                status: thread.lifecycle.as_str().into(),
                terminal: thread.lifecycle.is_terminal(),
                terminal_sequence: outcome.and_then(|outcome| outcome.terminal_event_sequence),
            };
            let projection = project_execution(&fact, &records);
            snapshot.response_annotations = Some(ThreadResponseAnnotations {
                protocol: thread.response_annotations,
                scope,
                title: (!truncated).then_some(projection.title).flatten(),
                progress: projection.progress,
                result: if outcome
                    .and_then(|outcome| outcome.terminal_event_sequence)
                    .is_some()
                    && thread.lifecycle != ThreadLifecycle::Cancelled
                {
                    projection.result
                } else {
                    None
                },
                steps: steps.into_values().collect(),
                source_count,
                truncated,
            });
        }
        // A cancellation/supersede racing the read cannot expose metadata
        // owned by the generation that has just lost its authority.
        let current = self
            .inner
            .store
            .list_threads_by_ids(context_id, &ids)
            .await?
            .into_iter()
            .map(|thread| (thread.id.clone(), thread))
            .collect::<HashMap<_, _>>();
        for snapshot in snapshots {
            if snapshot.response_annotations.is_some()
                && current.get(&snapshot.thread.id).is_none_or(|thread| {
                    thread.generation != snapshot.thread.generation
                        || thread.response_annotations != snapshot.thread.response_annotations
                        || thread.lifecycle != snapshot.thread.lifecycle
                })
            {
                snapshot.response_annotations = None;
            }
        }
        Ok(())
    }

    /// The caller authorizes the Session first. `Some(None)` is an existing
    /// Off/legacy Thread, whereas `None` is a missing or cross-Session route.
    pub async fn session_thread_annotations(
        &self,
        context_id: &str,
        session_id: &str,
        thread_id: &str,
    ) -> Result<Option<Option<ThreadResponseAnnotations>>, RuntimeError> {
        let Some(thread) = self.session_thread_by_id(session_id, thread_id).await? else {
            return Ok(None);
        };
        if thread.context_id != context_id {
            return Ok(None);
        }
        if thread.response_annotations.is_off() {
            return Ok(Some(None));
        }
        Ok(self
            .thread_detail(context_id, thread_id)
            .await?
            .map(|detail| detail.snapshot.response_annotations))
    }
}

#[cfg(test)]
mod tests {
    use super::intent_arguments_match;
    use serde_json::json;

    #[test]
    fn intent_matches_exact_business_arguments_with_runtime_routes() {
        let request = json!({
            "command": "read-only",
            "options": {"_annotations": "business data", "target": "nested"},
            "_morphz_execution_route": {"target_id": "synthetic-target"},
            "_morphz_artifact_transfer_routes": {},
            "_morphz_capability_lease_objective_id": "synthetic-objective",
            "_morphz_action_group_id": "synthetic-group",
            "_morphz_wake_thread": false
        });
        let mut source = json!({
            "command": "read-only",
            "options": {"_annotations": "business data", "target": "nested"},
            "target": "synthetic-target",
            "_annotations": {"intent": "read"}
        });
        assert!(intent_arguments_match(
            &source.to_string(),
            &request,
            "synthetic-target"
        ));
        source["command"] = json!("different-business-operation");
        assert!(!intent_arguments_match(
            &source.to_string(),
            &request,
            "synthetic-target"
        ));
        source["command"] = json!("read-only");
        source["options"]["_annotations"] = json!("changed nested business data");
        assert!(!intent_arguments_match(
            &source.to_string(),
            &request,
            "synthetic-target"
        ));
        source["options"]["_annotations"] = json!("business data");
        source["target"] = json!("other-target");
        assert!(!intent_arguments_match(
            &source.to_string(),
            &request,
            "synthetic-target"
        ));
        source.as_object_mut().unwrap().remove("target");
        assert!(intent_arguments_match(
            &source.to_string(),
            &request,
            "synthetic-target"
        ));
    }
}
