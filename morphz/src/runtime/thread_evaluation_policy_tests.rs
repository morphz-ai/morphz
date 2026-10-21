use super::*;
use crate::llm::{
    ModelAttemptBindingError, ModelFailure, ModelFailureKind, ModelRequestContext,
    ModelRequestOptions, ModelStreamEvent, ModelStreamSender, PromptTokenCount, Response,
    ToolCallRepr, ToolDefinition,
};
use crate::memory::{objective_primary_execution_root_id, stable_thread_id, SessionMountKind};
use crate::test_sqlite::TempSqliteDb;
use std::sync::atomic::AtomicUsize;
use std::sync::Mutex;

struct PolicyClient {
    runtime: Mutex<Weak<RuntimeInner>>,
    calls: AtomicUsize,
    bindings: Mutex<Vec<String>>,
    efforts: Mutex<Vec<String>>,
    schemas: Mutex<Vec<serde_json::Value>>,
    switch_before_failure: bool,
    session_only: bool,
    reply_only: bool,
}

impl PolicyClient {
    fn runtime(&self) -> MorphzRuntime {
        MorphzRuntime {
            inner: self.runtime.lock().unwrap().upgrade().unwrap(),
        }
    }

    async fn switch_policy(&self) -> Result<(), RuntimeError> {
        let runtime = self.runtime();
        let previous = runtime
            .inner
            .store
            .get_session("policy-live-session")
            .await?
            .unwrap();
        let current = runtime
            .inner
            .store
            .update_session(
                "policy-live-session",
                SessionUpdate {
                    model_alias: Some(Some("route-b".into())),
                    reasoning_effort: Some(Some("low".into())),
                    ..Default::default()
                },
            )
            .await?
            .unwrap();
        if self.session_only {
            // Exercise the real Session notification/convergence hook without
            // inventing a catalog entry for this synthetic Client's aliases.
            runtime
                .publish_session_evaluation_policy_changed(&previous, &current)
                .await?;
            return Ok(());
        }
        let root = objective_primary_execution_root_id("policy-live-goal", 1);
        let before = runtime
            .inner
            .store
            .get_thread_by_root(&root)
            .await?
            .unwrap();
        let changed = runtime
            .update_thread_evaluation_policy(
                &before.context_id,
                &before.id,
                before.revision,
                crate::model_selection::ModelSelection::default(),
            )
            .await?;
        let ThreadMutation::Updated(after) = changed else {
            panic!("operator CAS must succeed")
        };
        assert_eq!(after.generation, before.generation);
        assert_eq!(after.root_turn_id, before.root_turn_id);
        assert!(after.model_alias.is_none() && after.reasoning_effort.is_none());
        Ok(())
    }
}

#[async_trait::async_trait]
impl Client for PolicyClient {
    fn model(&self) -> Option<String> {
        Some("route-a".into())
    }

    fn provider_resource_key_for_binding(&self, binding: &ModelAttemptBinding) -> String {
        // Match the production ModelRoutingClient resource identity, rather
        // than the generic Client default's opaque test Provider identifier.
        format!("model-route:{}", binding.route_id)
    }

    async fn bind_requested_model_attempt(
        &self,
        _: &ModelRequestContext,
        requested: Option<&str>,
    ) -> Result<ModelAttemptBinding, ModelAttemptBindingError> {
        let alias = requested.unwrap_or("route-a").to_string();
        Ok(ModelAttemptBinding {
            requested_alias: alias.clone(),
            route_id: alias.clone(),
            route_revision: "test-1".into(),
            provider_instance_id: "test-policy-provider".into(),
            auth_account_id: "test-account".into(),
            physical_model: alias,
            protocol: "openai-chat".into(),
            provider_adapter: "test".into(),
            provider_adapter_version: "1".into(),
            endpoint: "http://127.0.0.1/test-policy".into(),
            request_session_id: None,
            capabilities: vec![],
            model_input_limits: Default::default(),
        })
    }

    async fn probe_health(&self) -> Result<(), RuntimeError> {
        std::future::pending().await
    }

    async fn create_completion(
        &self,
        _: Vec<crate::llm::Message>,
        _: Vec<ToolDefinition>,
    ) -> Result<Response, RuntimeError> {
        unreachable!("the real bound streaming path is required")
    }

    async fn create_completion_bound_stream_with_options(
        &self,
        binding: &ModelAttemptBinding,
        _: Vec<crate::llm::Message>,
        tools: Vec<ToolDefinition>,
        _: Option<PromptTokenCount>,
        stream: ModelStreamSender,
        options: ModelRequestOptions,
    ) -> Result<Response, RuntimeError> {
        self.bindings
            .lock()
            .unwrap()
            .push(binding.requested_alias.clone());
        self.efforts
            .lock()
            .unwrap()
            .push(match options.reasoning_effort {
                Some(Some(effort)) => effort.as_str().into(),
                Some(None) => "provider_default".into(),
                None => "client_default".into(),
            });
        self.schemas
            .lock()
            .unwrap()
            .push(serde_json::to_value(&tools)?);
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let _ = stream.send(ModelStreamEvent::Started);
        if self.reply_only {
            return Ok(Response {
                content: "TEST recurring policy preserved".into(),
                tool_calls: vec![],
            });
        }
        if call == 0 {
            if self.switch_before_failure {
                self.switch_policy().await?;
            }
            return Err(Box::new(
                ModelFailure::new(
                    if self.session_only {
                        ModelFailureKind::ProviderConfiguration
                    } else {
                        ModelFailureKind::ServerUnavailable
                    },
                    "synthetic old Provider failure",
                )
                .with_retry_after(Some(3600)),
            ));
        }
        if call == 1 {
            assert!(tools.iter().any(|tool| tool.name == "objective_update"));
            let objective = self
                .runtime()
                .get_objective("policy-live-goal")
                .await?
                .unwrap();
            return Ok(Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                id: "complete-policy-goal".into(), r#type: "function".into(),
                func_name: "objective_update".into(), arguments: json!({
                    "objective_id": objective.id, "base_revision": objective.revision,
                    "status": "completed", "reason": "TEST current policy completed the same goal",
                    "evidence_refs": [],
                }).to_string(),
            }],
            });
        }
        assert_eq!(
            call, 2,
            "policy recovery must not create extra model requests"
        );
        Ok(Response {
            content: "TEST policy goal complete".into(),
            tool_calls: vec![],
        })
    }
}

async fn run_live_primary_policy_switch(before_failure: bool, session_only: bool) {
    let database = TempSqliteDb::new().unwrap();
    let client = Arc::new(PolicyClient {
        runtime: Mutex::new(Weak::new()),
        calls: AtomicUsize::new(0),
        bindings: Mutex::new(vec![]),
        efforts: Mutex::new(vec![]),
        schemas: Mutex::new(vec![]),
        switch_before_failure: before_failure,
        session_only,
        reply_only: false,
    });
    let runtime = MorphzRuntime::builder(AppConfig::default(), client.clone())
        .database_path(database.path().to_string_lossy())
        .tool_policy(RuntimeToolPolicy {
            context_only: true,
            coding_eval: true,
        })
        .build()
        .await
        .unwrap();
    *client.runtime.lock().unwrap() = Arc::downgrade(&runtime.inner);
    runtime.start().await.unwrap();
    runtime
        .ensure_session(NewSession {
            id: "policy-live-session".into(),
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            parent_session_id: None,
            title: "TEST live primary policy".into(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    let root = objective_primary_execution_root_id("policy-live-goal", 1);
    // A synthetic legacy task snapshot reproduces the old copied input choice.
    let original = runtime
        .inner
        .store
        .ensure_thread(NewThread {
            response_annotations: Default::default(),
            model_alias: (!session_only).then(|| "route-a".into()),
            reasoning_effort: (!session_only).then(|| "high".into()),
            id: stable_thread_id(&root),
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            session_id: "policy-live-session".into(),
            initiating_principal_id: None,
            root_turn_id: root,
            kind: ThreadKind::Execution,
            executor_kind: "self".into(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::objective_primary_execution("policy-live-goal", 1),
        })
        .await
        .unwrap();
    runtime
        .create_objective(NewObjective {
            model_alias: None,
            reasoning_effort: None,
            id: "policy-live-goal".into(),
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            coordinator_session_id: "policy-live-session".into(),
            delivery_session_id: "policy-live-session".into(),
            parent_objective_id: None,
            source_event_id: "test-policy-source".into(),
            initiating_principal_id: None,
            stated_objective: "TEST continue this same goal after its operator changes model"
                .into(),
            token_budget: None,
        })
        .await
        .unwrap();
    if !before_failure {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let goal = runtime
                    .get_objective("policy-live-goal")
                    .await
                    .unwrap()
                    .unwrap();
                if matches!(
                    goal.wait_condition,
                    Some(ObjectiveWaitCondition::ResourceAvailable { .. })
                ) && goal.active_evaluation_id.is_none()
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the real old physical failure must become a durable Objective wait");
        client.switch_policy().await.unwrap();
    }
    let completed = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let goal = runtime
                .get_objective("policy-live-goal")
                .await
                .unwrap()
                .unwrap();
            if goal.status == ObjectiveStatus::Completed && goal.active_evaluation_id.is_none() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await;
    if completed.is_err() {
        let goal = runtime.get_objective("policy-live-goal").await.unwrap();
        let dependencies = runtime
            .inner
            .store
            .list_scheduler_dependencies(SchedulerDependencyFilter {
                owner_kind: Some(SchedulerDependencyOwnerKind::Objective),
                owner_id: Some("policy-live-goal".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        let events = runtime
            .query_events(QueryFilter {
                context_id: Some(runtime.identity().context_id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()
            .into_iter()
            .filter(|event| {
                event.payload.contains_key("runtime_failure_kind")
                    || event.topic.starts_with("objective/")
                    || event.topic == "runtime/thread_evaluation_policy_changed"
            })
            .collect::<Vec<_>>();
        panic!("the same real Objective must resume with the current Thread policy; goal={goal:?}; dependencies={dependencies:?}; bindings={:?}; events={events:?}", client.bindings.lock().unwrap());
    }
    assert_eq!(
        *client.bindings.lock().unwrap(),
        ["route-a", "route-b", "route-b"]
    );
    assert_eq!(client.calls.load(Ordering::SeqCst), 3);
    assert_eq!(
        *client.efforts.lock().unwrap(),
        [
            if session_only {
                "provider_default"
            } else {
                "high"
            },
            "low",
            "low"
        ]
    );
    {
        let schemas = client.schemas.lock().unwrap();
        assert_eq!(schemas.len(), 3);
        assert!(schemas.iter().all(|schema| schema == &schemas[0]));
    }
    let current = runtime
        .inner
        .store
        .get_thread(&original.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.generation, original.generation);
    assert_eq!(current.root_turn_id, original.root_turn_id);
    if session_only {
        assert_eq!(
            runtime
                .inner
                .store
                .get_thread_evaluation_policy(&original.id)
                .await
                .unwrap()
                .unwrap()
                .control_revision,
            None,
            "Session-only recovery must not pass through an operator Thread update"
        );
    }
    let failures = runtime
        .query_events(QueryFilter {
            context_id: Some(runtime.identity().context_id.clone()),
            ..Default::default()
        })
        .await
        .unwrap()
        .into_iter()
        .filter(|event| {
            event.payload.contains_key("runtime_failure_kind")
                && event
                    .payload
                    .get("objective_id")
                    .and_then(serde_json::Value::as_str)
                    == Some("policy-live-goal")
        })
        .collect::<Vec<_>>();
    assert!(
        failures.iter().any(
            |event| event.payload.get("thread_evaluation_policy_revision")
                == Some(&serde_json::Value::Null)
        ),
        "the actual Runtime must carry the request-policy revision into its real failure Outcome"
    );
    assert!(
        failures.iter().any(|event| event
            .payload
            .get("session_evaluation_policy")
            .and_then(crate::model_selection::SessionEvaluationSnapshot::from_metadata)
            .is_some()),
        "physical failure must carry a valid immutable Session inheritance snapshot"
    );
}

#[tokio::test]
async fn primary_policy_change_before_real_failure_resumes_the_same_objective() {
    run_live_primary_policy_switch(true, false).await;
}

#[tokio::test]
async fn primary_policy_change_after_real_wait_resumes_without_global_configuration_event() {
    run_live_primary_policy_switch(false, false).await;
}

#[tokio::test]
async fn inherited_session_change_before_real_configuration_failure_resumes_the_same_objective() {
    run_live_primary_policy_switch(true, true).await;
}

#[tokio::test]
async fn inherited_session_change_after_real_configuration_wait_resumes_the_same_objective() {
    run_live_primary_policy_switch(false, true).await;
}

#[tokio::test]
async fn clearing_recurring_template_policy_keeps_explicit_schedule_effort_and_same_timer() {
    let database = TempSqliteDb::new().unwrap();
    let client = Arc::new(PolicyClient {
        runtime: Mutex::new(Weak::new()),
        calls: AtomicUsize::new(0),
        bindings: Mutex::new(vec![]),
        efforts: Mutex::new(vec![]),
        schemas: Mutex::new(vec![]),
        switch_before_failure: false,
        session_only: false,
        reply_only: true,
    });
    let runtime = MorphzRuntime::builder(AppConfig::default(), client.clone())
        .database_path(database.path().to_string_lossy())
        .build()
        .await
        .unwrap();
    *client.runtime.lock().unwrap() = Arc::downgrade(&runtime.inner);
    runtime.start().await.unwrap();
    runtime
        .ensure_session(NewSession {
            id: "policy-recurring-session".into(),
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            parent_session_id: None,
            title: "TEST template policy and explicit timer".into(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
        .unwrap();
    runtime
        .inner
        .store
        .update_session(
            "policy-recurring-session",
            SessionUpdate {
                model_alias: Some(Some("route-b".into())),
                reasoning_effort: Some(Some("low".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .unwrap();
    let template = runtime
        .inner
        .store
        .ensure_thread(NewThread {
            response_annotations: Default::default(),
            model_alias: Some("old-copied-route".into()),
            reasoning_effort: Some("max".into()),
            id: "policy-recurring-template".into(),
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            session_id: "policy-recurring-session".into(),
            initiating_principal_id: None,
            root_turn_id: "policy-recurring-root".into(),
            kind: ThreadKind::Execution,
            executor_kind: "self".into(),
            executor_id: None,
            target_id: None,
            supervision: ThreadSupervision::runtime("TEST recurring template"),
        })
        .await
        .unwrap();
    let schedule = runtime
        .inner
        .store
        .ensure_schedule(crate::memory::NewSchedule {
            id: "policy-recurring-schedule".into(),
            thread_id: template.id.clone(),
            source_turn_id: template.root_turn_id.clone(),
            intent: "TEST preserve the original timer and high effort".into(),
            model_alias: None,
            reasoning_effort: Some("high".into()),
            not_before: Some(chrono::Utc::now() + chrono::Duration::milliseconds(30)),
            interval_seconds: Some(3600),
            dependency_thread_ids: vec![],
        })
        .await
        .unwrap();
    let ThreadMutation::Updated(changed) = runtime
        .update_thread_evaluation_policy(
            &template.context_id,
            &template.id,
            template.revision,
            crate::model_selection::ModelSelection::default(),
        )
        .await
        .unwrap()
    else {
        panic!("the exact template CAS must succeed")
    };
    assert_eq!(changed.generation, template.generation);
    assert_eq!(
        runtime
            .inner
            .store
            .get_schedule(&schedule.id)
            .await
            .unwrap()
            .unwrap(),
        schedule,
        "policy correction must not reschedule, revise or replace the timer"
    );
    assert_eq!(
        client.calls.load(Ordering::SeqCst),
        0,
        "changing policy alone never invokes a model"
    );
    let mut replies = runtime.subscribe("chat/reply", 4);
    runtime
        .inner
        .thread_scheduler
        .arm(schedule.clone())
        .await
        .unwrap();
    let reply = tokio::time::timeout(std::time::Duration::from_secs(10), replies.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reply.payload["text"], "TEST recurring policy preserved");
    let root = crate::tool::scheduled_occurrence_root(&schedule.id, schedule.revision);
    let occurrence = runtime
        .inner
        .store
        .get_thread_by_root(&root)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(occurrence.id, template.id);
    assert_eq!(occurrence.model_alias, None);
    assert_eq!(occurrence.reasoning_effort.as_deref(), Some("high"));
    assert_eq!(*client.bindings.lock().unwrap(), ["route-b"]);
    assert_eq!(*client.efforts.lock().unwrap(), ["high"]);
    assert_eq!(client.calls.load(Ordering::SeqCst), 1);
    let next = runtime
        .inner
        .store
        .get_schedule(&schedule.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(next.id, schedule.id);
    assert_eq!(next.thread_id, template.id);
    assert_eq!(next.interval_seconds, schedule.interval_seconds);
    assert_eq!(next.reasoning_effort, schedule.reasoning_effort);
    assert_eq!(
        next.revision,
        schedule.revision + 1,
        "only the real occurrence advances the timer"
    );
}
