//! Native ownership against real workerd. No model or physical tool executes.
use super::*;
use morphz::memory::remote::{http::HttpRemoteStoreTransport, RemoteRuntimeStore};
use std::sync::Arc;

async fn interrupt_owner(
    store: &dyn RuntimeStore,
    batch: &Batch,
    label: &str,
) -> (ObjectiveRecord, Option<String>) {
    use morphz::scheduler::{SchedulerDependencyFilter, SchedulerDependencyOwnerKind};
    let a = store
        .get_thread_activation(&batch.request.activation_id)
        .await
        .unwrap()
        .unwrap();
    let o = store
        .create_objective(NewObjective {
            id: format!("objective-{label}"),
            agent_id: a.agent_id,
            context_id: a.context_id,
            coordinator_session_id: a.session_id.clone(),
            delivery_session_id: a.session_id,
            parent_objective_id: None,
            source_event_id: a.trigger_event_id,
            initiating_principal_id: a.initiating_principal_id,
            stated_objective: "Synthetic exact dependency".into(),
            token_budget: None,
        })
        .await
        .unwrap();
    let ObjectiveMutation::Updated(waiting) = store
        .update_objective_state(
            &o.id,
            o.revision,
            ObjectiveStatus::Active,
            Some(ObjectiveWaitCondition::Timer {
                deadline: Utc::now() + Duration::hours(1),
            }),
            None,
        )
        .await
        .unwrap()
    else {
        panic!("dependency was not installed")
    };
    let dependencies = store
        .list_scheduler_dependencies(SchedulerDependencyFilter {
            owner_kind: Some(SchedulerDependencyOwnerKind::Objective),
            owner_id: Some(o.id.clone()),
            required_only: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(dependencies.len(), 1);
    let dependency = dependencies[0].id.clone();
    let ObjectiveMutation::Updated(claimed) = store
        .claim_objective_interrupt_evaluation(
            &o.id,
            waiting.revision,
            &format!("evaluation-{label}"),
            Utc::now() + Duration::minutes(5),
            &dependency,
        )
        .await
        .unwrap()
    else {
        panic!("interrupt was not claimed")
    };
    (claimed, Some(dependency))
}

#[tokio::test]
#[ignore = "requires the real Agent Cell workerd conformance server"]
async fn workerd_objective_parking_retains_its_exact_evaluation() {
    let base = std::env::var("MORPHZ_TEST_REMOTE_STORE_URL").unwrap();
    for mode in ["direct", "prelude", "interrupt"] {
        for decision in ["allow", "deny", "changed-dependency"] {
            let late = mode == "prelude";
            let label = format!("objective-park-{mode}-{decision}");
            let endpoint = format!(
                "{}{label}-{}",
                base.replace("/runtime-store/", "/managed-runtime-store/"),
                Utc::now().timestamp_nanos_opt().unwrap()
            );
            let connect = || {
                RemoteRuntimeStore::connect_owned(Arc::new(
                    HttpRemoteStoreTransport::new(&endpoint, "conformance-only").unwrap(),
                ))
            };
            let store = connect().await.unwrap();
            let mut first = seed(&store, &label).await;
            let mut second =
                objective_owners::additional_owner(&store, &first, &format!("{label}-sibling"))
                    .await;
            let (owner, dependency) = if mode == "interrupt" {
                interrupt_owner(&store, &first, &label).await
            } else {
                (
                    objective_owners::objective(&store, &first, &label).await,
                    None,
                )
            };
            let evaluation = owner.active_evaluation_id.as_ref().unwrap();
            if dependency.is_none() {
                assert!(matches!(
                    store
                        .renew_objective_evaluation(
                            &owner.id,
                            evaluation,
                            Utc::now() + Duration::minutes(5),
                        )
                        .await
                        .unwrap(),
                    ObjectiveMutation::Updated(_)
                ));
            }
            objective_owners::bind_with_dependency(
                &store,
                &mut first,
                &owner,
                late,
                dependency.as_deref(),
            )
            .await;
            objective_owners::bind_with_dependency(
                &store,
                &mut second,
                &owner,
                false,
                dependency.as_deref(),
            )
            .await;
            store.complete_recovery().await.unwrap();
            checkpoint(&store, &second).await;
            assert!(!store.try_park(|| true).await.unwrap());
            assert!(store
                .get_objective_approval_wait(&owner.id)
                .await
                .unwrap()
                .is_none());
            // The late creation prelude is deliberately the final anchor.
            checkpoint(&store, &first).await;
            let parked = store.get_objective(&owner.id).await.unwrap().unwrap();
            let wait = store
                .get_objective_approval_wait(&owner.id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(wait.activation_id, first.request.activation_id);
            assert_eq!(parked.active_evaluation_id, owner.active_evaluation_id);
            assert_eq!(parked.revision, owner.revision);
            assert_eq!(parked.continuation_sequence, owner.continuation_sequence);
            assert!(parked.evaluation_lease_expires_at.is_none());
            let mut drained = false;
            for _ in 0..8 {
                let projected = store
                    .project_recall_outbox_batch("objective-park", 128)
                    .await
                    .unwrap();
                assert_eq!(projected.failed, 0);
                if projected.claimed == 0 {
                    drained = true;
                    break;
                }
            }
            assert!(drained);
            if decision == "changed-dependency" {
                let ObjectiveMutation::Updated(changed) = store
                    .update_objective_state(
                        &owner.id,
                        parked.revision,
                        ObjectiveStatus::Active,
                        Some(ObjectiveWaitCondition::Timer {
                            deadline: Utc::now() + Duration::hours(2),
                        }),
                        None,
                    )
                    .await
                    .unwrap()
                else {
                    panic!("dependency was not changed")
                };
                assert_eq!(changed.active_evaluation_id, parked.active_evaluation_id);
                assert_eq!(
                    store
                        .get_objective_approval_wait(&owner.id)
                        .await
                        .unwrap()
                        .unwrap(),
                    wait
                );
                assert!(
                    !store.try_park(|| true).await.unwrap(),
                    "stale dependency must prevent parking"
                );
                for job in first.jobs.iter().chain(&second.jobs) {
                    assert_eq!(
                        store.get_execution_job(&job.id).await.unwrap().unwrap(),
                        *job
                    );
                }
                continue;
            }
            assert!(
                store.try_park(|| true).await.unwrap(),
                "complete Objective checkpoint must park: {label}"
            );
            assert!(store.ownership_lost());
            drop(store);

            let restored = connect().await.unwrap();
            assert_eq!(
                restored.get_objective(&owner.id).await.unwrap().unwrap(),
                parked
            );
            assert_eq!(
                restored
                    .get_objective_approval_wait(&owner.id)
                    .await
                    .unwrap()
                    .unwrap(),
                wait
            );
            assert_waiting(&restored, &first).await;
            assert_waiting(&restored, &second).await;
            restored.complete_recovery().await.unwrap();
            resolve(&restored, &first, decision).await;
            assert!(!restored.try_park(|| true).await.unwrap());
            let activation = restored
                .get_thread_activation(&first.request.activation_id)
                .await
                .unwrap()
                .unwrap();
            let ThreadActivationMutation::Updated(running) = restored
                .update_thread_activation(
                    &activation.id,
                    activation.revision,
                    ThreadActivationStatus::Running,
                    Some("objective-park-resume"),
                    Some(Utc::now() + Duration::minutes(5)),
                    None,
                )
                .await
                .unwrap()
            else {
                panic!("exact Activation was not claimed")
            };
            let ObjectiveMutation::Updated(resumed) = restored
                .admit_objective_activation(ObjectiveActivationAdmission {
                    objective_id: owner.id.clone(),
                    evaluation_id: evaluation.clone(),
                    activation_id: running.id,
                    claimed_by: "objective-park-resume".into(),
                    lease_expires_at: Utc::now() + Duration::minutes(5),
                    pending_dependency_id: dependency,
                })
                .await
                .unwrap()
            else {
                panic!("exact Evaluation was not reacquired")
            };
            assert_eq!(resumed.active_evaluation_id, parked.active_evaluation_id);
            assert_eq!(resumed.revision, parked.revision);
            assert_eq!(resumed.continuation_sequence, parked.continuation_sequence);
            for approval in first.approvals.iter().chain(&second.approvals) {
                assert!(restored
                    .get_approval(&approval.id)
                    .await
                    .unwrap()
                    .unwrap()
                    .grant_consumed_at
                    .is_none());
            }
            for job in first.jobs.iter().chain(&second.jobs) {
                assert!(restored
                    .get_execution_job(&job.id)
                    .await
                    .unwrap()
                    .unwrap()
                    .side_effect_started_at
                    .is_none());
            }
        }
    }
}
