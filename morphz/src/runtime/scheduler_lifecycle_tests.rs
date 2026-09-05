use super::*;
use crate::llm::{Message, Response, ToolCallRepr, ToolDefinition};
use crate::memory::*;
use crate::scheduler::{
    SchedulerDependencyFilter, SchedulerDependencyOwnerKind, SchedulerDependencyStatus,
};
use crate::tool::{
    ToolCausalRoute, CURRENT_ATTEMPT_ID, CURRENT_CAUSAL_ROUTE, CURRENT_CONTEXT_ID,
    CURRENT_SESSION_ID,
};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};

struct CancelClient {
    calls: AtomicUsize,
}
#[async_trait::async_trait]
impl Client for CancelClient {
    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, RuntimeError> {
        assert!(
            tools.iter().any(|tool| tool.name == "thread_control"),
            "Thread control must reach the real model schema, not just Registry"
        );
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            Ok(Response { content: String::new(), tool_calls: vec![ToolCallRepr {
                id: "cancel-model-child".into(), r#type: "function".into(), func_name: "thread_control".into(),
                arguments: json!({"thread_id":"model-child","expected_revision":1,"action":"cancel","reason":"user abandoned this pending work"}).to_string(),
            }] })
        } else {
            Ok(Response {
                content: "Cancellation complete".into(),
                tool_calls: vec![],
            })
        }
    }
}

async fn fixture() -> (tempfile::NamedTempFile, MorphzRuntime) {
    fixture_with_client(Arc::new(CancelClient {
        calls: AtomicUsize::new(0),
    }))
    .await
}

async fn fixture_with_client(client: Arc<dyn Client>) -> (tempfile::NamedTempFile, MorphzRuntime) {
    let file = tempfile::NamedTempFile::new().unwrap();
    let runtime = MorphzRuntime::builder(AppConfig::default(), client)
        .database_path(file.path().to_string_lossy())
        .build()
        .await
        .unwrap();
    runtime
        .inner
        .store
        .create_agent_bundle(
            NewAgent {
                id: runtime.identity().agent_id.clone(),
                title: "Cancel chain".into(),
                root_context_id: runtime.identity().context_id.clone(),
            },
            NewCognitiveContext {
                id: runtime.identity().context_id.clone(),
                agent_id: runtime.identity().agent_id.clone(),
                title: "Cancel chain".into(),
            },
            NewSession {
                id: "session-cancel-chain".into(),
                agent_id: runtime.identity().agent_id.clone(),
                context_id: runtime.identity().context_id.clone(),
                parent_session_id: None,
                title: "Cancel chain".into(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await
        .unwrap();
    runtime
        .bind_session_principal(
            "session-cancel-chain",
            PrincipalAssertion {
                principal_id: runtime.identity().principal_id.clone(),
                provider_id: "runtime-default".into(),
                assurance: "test".into(),
                display_name: None,
            },
        )
        .await
        .unwrap();
    (file, runtime)
}

struct ScriptedInterruptClient {
    responses: std::sync::Mutex<std::collections::VecDeque<Response>>,
    receipt_started: tokio::sync::Notify,
    receipt_release: tokio::sync::Notify,
}
#[async_trait::async_trait]
impl Client for ScriptedInterruptClient {
    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, RuntimeError> {
        let response = self.responses.lock().unwrap().pop_front();
        match response {
            Some(response) => {
                if response.content == "simulate-receipt-overflow" {
                    assert_eq!(
                        tools
                            .iter()
                            .map(|tool| tool.name.as_str())
                            .collect::<Vec<_>>(),
                        vec!["no_reply"]
                    );
                    return Err(Box::new(crate::llm::ModelFailure::new(
                        crate::llm::ModelFailureKind::ContextLimit,
                        "simulated provider context_length_exceeded during receipt",
                    )));
                }
                for call in &response.tool_calls {
                    if call.id == "forbidden-receipt-control" {
                        assert_eq!(
                            tools
                                .iter()
                                .map(|tool| tool.name.as_str())
                                .collect::<Vec<_>>(),
                            vec!["no_reply"]
                        );
                        continue;
                    }
                    assert!(tools.iter().any(|tool| tool.name == call.func_name));
                }
                if response.content.starts_with("The four replacement workers") {
                    assert_eq!(
                        tools
                            .iter()
                            .map(|tool| tool.name.as_str())
                            .collect::<Vec<_>>(),
                        vec!["no_reply"]
                    );
                    self.receipt_started.notify_one();
                    self.receipt_release.notified().await;
                }
                Ok(response)
            }
            None => std::future::pending().await,
        }
    }
}

#[tokio::test]
async fn directed_objective_interrupt_cancels_four_children_and_spawns_replacements_through_real_tool_outputs(
) {
    assert_directed_interrupt_chain(false).await;
}

#[tokio::test]
async fn directed_objective_interrupt_preserves_wait_through_nested_yao_infer() {
    assert_directed_interrupt_chain(true).await;
}

#[tokio::test]
async fn objective_create_prelude_and_sibling_infer_keep_ordinary_plan_authority() {
    let call = |id: &str, name: &str, arguments: Value| ToolCallRepr {
        id: id.into(),
        r#type: "function".into(),
        func_name: name.into(),
        arguments: arguments.to_string(),
    };
    let client = Arc::new(ScriptedInterruptClient {
        responses: std::sync::Mutex::new(std::collections::VecDeque::from([
            Response {
                content: String::new(),
                tool_calls: vec![
                    call(
                        "create-before-infer",
                        "objective_create",
                        json!({"stated_objective":"Complete a durable multi-stage analysis", "reason":"several supervised stages", "source_refs":[]}),
                    ),
                    call(
                        "prelude-infer",
                        "eval",
                        json!({"program":"(eval (infer (add 20 22)))"}),
                    ),
                ],
            },
            Response {
                content: "42".into(),
                tool_calls: vec![],
            },
        ])),
        receipt_started: Default::default(),
        receipt_release: Default::default(),
    });
    let (_file, runtime) = fixture_with_client(client).await;
    runtime.start().await.unwrap();
    let mut outputs = runtime.subscribe("chat/tool_output", 16);
    runtime
        .session("session-cancel-chain")
        .send(
            "Create a durable objective and begin analysis",
            "User",
            Some("prelude-message".into()),
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let output = outputs.recv().await.unwrap();
            if output.payload.get("tool_call_id").and_then(Value::as_str) == Some("prelude-infer") {
                assert_eq!(
                    output.payload.get("tool_status").and_then(Value::as_str),
                    Some("success"),
                    "{:?}",
                    output.payload
                );
                assert_eq!(
                    output.payload.get("text").and_then(Value::as_str),
                    Some("42")
                );
                break;
            }
        }
    })
    .await
    .unwrap();
    let plans = runtime
        .inner
        .store
        .list_plan_executions(PlanExecutionFilter {
            session_id: Some("session-cancel-chain".into()),
            include_terminal: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(plans.len(), 1);
    assert_eq!(plans[0].status, PlanExecutionStatus::Succeeded);
    assert_eq!(plans[0].result_json, Some(json!(42)));
    assert!(plans[0].objective_id.is_some());
}

async fn assert_directed_interrupt_chain(with_infer: bool) {
    let client = Arc::new(ScriptedInterruptClient {
        responses: Default::default(),
        receipt_started: Default::default(),
        receipt_release: Default::default(),
    });
    let (_file, runtime) = fixture_with_client(client.clone()).await;
    let parent = runtime
        .inner
        .store
        .ensure_thread(thread(&runtime, "original-planner"))
        .await
        .unwrap();
    let objective = runtime
        .inner
        .store
        .create_objective(NewObjective {
            id: "live-interrupt-objective".into(),
            agent_id: parent.agent_id.clone(),
            context_id: parent.context_id.clone(),
            coordinator_session_id: parent.session_id.clone(),
            delivery_session_id: parent.session_id.clone(),
            parent_objective_id: None,
            source_event_id: "live-objective-source".into(),
            initiating_principal_id: None,
            stated_objective: "four verified results".into(),
            token_budget: None,
        })
        .await
        .unwrap();
    let args = json!({"operations":(0..4).map(|i| json!({"op":"spawn","client_id":format!("child-{i}"),"intent":format!("verify part {i}"),"delay_seconds":3600,"lifetime":"durable","objective":{"mode":"existing","objective_id":objective.id}})).collect::<Vec<_>>(),"group":{"policy":"all"}});
    let receipt = invoke(
        &runtime,
        &parent,
        "live-spawn-original",
        "schedule_tx",
        args.clone(),
    )
    .await;
    let schedules: Vec<ScheduleRecord> =
        serde_json::from_value(receipt["operations"].clone()).unwrap();
    let call = |id: String, name: &str, args: Value| Response {
        content: String::new(),
        tool_calls: vec![ToolCallRepr {
            id,
            r#type: "function".into(),
            func_name: name.into(),
            arguments: args.to_string(),
        }],
    };
    if with_infer {
        client.responses.lock().unwrap().push_back(call(
            "live-infer".into(),
            "eval",
            json!({"program":"(eval (infer (add 20 22)))"}),
        ));
        client.responses.lock().unwrap().push_back(Response {
            content: "42".into(),
            tool_calls: vec![],
        });
    }
    for (index, schedule) in schedules.iter().enumerate() {
        client.responses.lock().unwrap().push_back(call(format!("live-cancel-{index}"), "thread_control", json!({"thread_id":schedule.thread_id,"expected_revision":1,"action":"cancel","reason":"user requested replacement"})));
    }
    client.responses.lock().unwrap().push_back(call(
        "live-replacement".into(),
        "schedule_tx",
        args,
    ));
    if with_infer {
        client.responses.lock().unwrap().push_back(call(
            "forbidden-receipt-control".into(), "thread_control",
            json!({"thread_id":parent.id,"expected_revision":1,"action":"cancel","reason":"must never execute during receipt-only response"}),
        ));
        let mut responses = client.responses.lock().unwrap();
        let index = responses.len() - 1;
        responses.insert(
            index,
            Response {
                content: "simulate-receipt-overflow".into(),
                tool_calls: vec![],
            },
        );
    }
    client.responses.lock().unwrap().push_back(Response {
        content: "The four replacement workers are scheduled; their results are still pending."
            .into(),
        tool_calls: vec![],
    });
    runtime.start().await.unwrap();
    let mut outputs = runtime.subscribe("chat/tool_output", 32);
    let mut replies = runtime.subscribe("chat/reply", 8);
    let ingress = runtime
        .session(&parent.session_id)
        .send_as_principal_with_options(
            "Cancel the four old children and create four replacements",
            "User",
            runtime.identity().principal_id.clone(),
            Some("live-steering-message".into()),
            SessionMessageOptions {
                input_destination: Some(crate::steering::InputDestination::Objective {
                    objective_id: objective.id.clone(),
                    generation: objective.generation,
                    reply_to_request_id: None,
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let mut dependency_id = None;
    let mut replacement_receipt = None;
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let output = outputs.recv().await.unwrap();
            let call_id = output.payload.get("tool_call_id").and_then(Value::as_str).unwrap_or_default();
            if !call_id.starts_with("live-") { continue; }
            assert_eq!(output.payload.get("tool_status").and_then(Value::as_str), Some("success"), "{:?}", output.payload);
            if call_id == "live-infer" {
                assert_eq!(output.payload.get("text").and_then(Value::as_str), Some("42"), "nested infer must return its real typed result: {:?}", output.payload);
                let children = runtime.inner.store.list_context_threads(&parent.context_id, true).await.unwrap();
                let child = children.iter().find(|child| child.executor_kind == "plan_infer").expect("the test must traverse the durable infer child path");
                assert_eq!(child.lifecycle, ThreadLifecycle::Completed);
                let plan = runtime.inner.store.get_plan_execution(child.executor_id.as_deref().unwrap()).await.unwrap().unwrap();
                assert_eq!(plan.status, PlanExecutionStatus::Succeeded);
                assert_eq!(plan.result_json, Some(json!(42)));
                assert_eq!(plan.objective_id.as_deref(), Some(objective.id.as_str()));
            }
            if dependency_id.is_none() {
                assert_eq!(output.payload.get("trigger_event_id").and_then(Value::as_str), Some(ingress.event_id.as_str()), "the scripted response must be caused by the directed user input");
            }
            let exact = output.payload.get("objective_pending_dependency_id").and_then(Value::as_str).unwrap_or_else(|| panic!("every real tool output must preserve the interrupt wait fence: {:?}", output.payload)).to_string();
            if let Some(expected) = &dependency_id { assert_eq!(expected, &exact); }
            dependency_id = Some(exact);
            if call_id == "live-replacement" { replacement_receipt = Some(output); break; }
        }
    }).await.expect("the directed interrupt must finish cancellation and create replacement work without another user message");
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        client.receipt_started.notified(),
    )
    .await
    .unwrap();
    let replacement_receipt = replacement_receipt.unwrap();
    let supervisor = &runtime.inner.objective_supervisor;
    let receipt_dependency = supervisor
        .schedule_receipt_dependency(&replacement_receipt)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(
        Some(&receipt_dependency),
        dependency_id.as_ref(),
        "receipt liveness is not ordinary authority over the replacement wait"
    );
    for (key, value) in [
        ("objective_evaluation_id", json!("stale-evaluation")),
        ("attempt_id", json!("another-producer")),
        ("thread_id", json!("another-thread")),
        (
            "text",
            json!(
                "{\"status\":\"committed\",\"thread_groups\":[{\"group_id\":\"another-group\"}]}"
            ),
        ),
    ] {
        let mut forged = replacement_receipt.clone();
        forged.payload.insert(key.into(), value);
        assert!(
            supervisor
                .schedule_receipt_dependency(&forged)
                .await
                .unwrap()
                .is_none(),
            "{key}"
        );
    }
    // Hold the real model response across three heartbeat intervals. The
    // receipt must stay alive without broadening its old execution authority.
    tokio::time::pause();
    let mut clock_guard = tokio::task::JoinSet::new();
    clock_guard.spawn(async {
        loop {
            tokio::task::yield_now().await;
        }
    });
    for _ in 0..3 {
        let before = runtime
            .inner
            .store
            .get_objective(&objective.id)
            .await
            .unwrap()
            .unwrap()
            .evaluation_lease_expires_at;
        tokio::time::advance(std::time::Duration::from_secs(31)).await;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if runtime
                .inner
                .store
                .get_objective(&objective.id)
                .await
                .unwrap()
                .unwrap()
                .evaluation_lease_expires_at
                > before
            {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "the scheduled heartbeat must complete its durable IO before advancing the clock again");
            tokio::task::yield_now().await;
        }
        assert!(
            runtime
                .inner
                .store
                .get_objective(&objective.id)
                .await
                .unwrap()
                .unwrap()
                .evaluation_lease_expires_at
                > before,
            "receipt-only model request must retain liveness beyond the heartbeat interval"
        );
    }
    tokio::time::resume();
    clock_guard.abort_all();
    client.receipt_release.notify_one();
    let reply = tokio::time::timeout(std::time::Duration::from_secs(10), replies.recv())
        .await
        .expect("a committed replacement wait must allow the parent to explain the arrangement")
        .unwrap();
    assert!(reply.payload["text"]
        .as_str()
        .unwrap()
        .contains("replacement workers"));
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if runtime
                .inner
                .store
                .get_objective(&objective.id)
                .await
                .unwrap()
                .unwrap()
                .active_evaluation_id
                .is_none()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect(
        "the final receipt must release the Objective Evaluation without waiting for lease expiry",
    );
    assert!(
        supervisor
            .schedule_receipt_dependency(&replacement_receipt)
            .await
            .unwrap()
            .is_none(),
        "a delivered receipt cannot revive the completed Evaluation"
    );
    assert!(
        !runtime
            .inner
            .store
            .query(QueryFilter {
                context_id: Some(parent.context_id.clone()),
                topic: Some("chat/tool_output".into()),
                ..Default::default()
            })
            .await
            .unwrap()
            .iter()
            .any(|event| event.payload["tool_call_id"] == "forbidden-receipt-control"),
        "forbidden receipt-only control must fail before tool execution"
    );
    for schedule in schedules {
        assert_eq!(
            runtime
                .inner
                .store
                .get_thread(&schedule.thread_id)
                .await
                .unwrap()
                .unwrap()
                .lifecycle,
            ThreadLifecycle::Cancelled
        );
    }
    let old_group = runtime
        .inner
        .store
        .get_thread_group(receipt["thread_groups"][0]["group_id"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(old_group.terminal_count, 4);
    let current = runtime
        .inner
        .store
        .get_objective(&objective.id)
        .await
        .unwrap()
        .unwrap();
    let Some(ObjectiveWaitCondition::ThreadGroup { group_id }) = current.wait_condition else {
        panic!("replacement group must be installed")
    };
    assert_ne!(group_id, old_group.id);
    let replacement = runtime
        .inner
        .store
        .get_thread_group(&group_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(replacement.required_count, 4);
    assert_eq!(replacement.terminal_count, 0);
    assert!(
        runtime
            .inner
            .store
            .get_thread_by_root(&ingress.event_id)
            .await
            .unwrap()
            .is_none(),
        "directed steering must not create a duplicate DialogueTurn"
    );
}

fn thread(runtime: &MorphzRuntime, id: &str) -> NewThread {
    NewThread {
        id: id.into(),
        agent_id: runtime.identity().agent_id.clone(),
        context_id: runtime.identity().context_id.clone(),
        session_id: "session-cancel-chain".into(),
        initiating_principal_id: None,
        root_turn_id: format!("root-{id}"),
        kind: ThreadKind::Execution,
        executor_kind: "self".into(),
        executor_id: None,
        target_id: None,
        supervision: ThreadSupervision::runtime("fixture"),
    }
}

async fn invoke(
    runtime: &MorphzRuntime,
    parent: &ThreadRecord,
    activation: &str,
    tool: &str,
    args: Value,
) -> Value {
    let route = ToolCausalRoute {
        thread_id: parent.id.clone(),
        root_turn_id: parent.root_turn_id.clone(),
        activation_id: activation.into(),
        model_attempt_id: None,
        trigger_event_id: "fixture-trigger".into(),
        trigger_sequence: 1,
    };
    let tool = runtime.inner.registry.get(tool).unwrap();
    let output = CURRENT_CONTEXT_ID
        .scope(
            parent.context_id.clone(),
            CURRENT_SESSION_ID.scope(
                parent.session_id.clone(),
                CURRENT_ATTEMPT_ID.scope(
                    activation.into(),
                    CURRENT_CAUSAL_ROUTE.scope(Some(route), tool.execute(&args.to_string())),
                ),
            ),
        )
        .await
        .unwrap();
    serde_json::from_str(&output).unwrap()
}

#[tokio::test]
async fn registered_thread_control_is_visible_and_executable_by_the_model() {
    let (_file, runtime) = fixture().await;
    runtime
        .inner
        .store
        .ensure_thread(thread(&runtime, "model-child"))
        .await
        .unwrap();
    runtime.start().await.unwrap();
    let mut replies = runtime.subscribe("chat/reply", 8);
    runtime
        .session("session-cancel-chain")
        .send(
            "Cancel the pending child",
            "User",
            Some("cancel-child-message".into()),
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(15), replies.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        runtime
            .inner
            .store
            .get_thread("model-child")
            .await
            .unwrap()
            .unwrap()
            .lifecycle,
        ThreadLifecycle::Cancelled
    );
    assert_eq!(
        runtime
            .inner
            .store
            .get_thread_outcome("model-child")
            .await
            .unwrap()
            .unwrap()
            .terminal_kind,
        ThreadLifecycle::Cancelled
    );
}

#[tokio::test]
async fn four_unstarted_children_cancel_completely_and_can_be_replaced_after_reopen() {
    let (file, runtime) = fixture().await;
    let parent = runtime
        .inner
        .store
        .ensure_thread(thread(&runtime, "parent"))
        .await
        .unwrap();
    let spawn = || json!({"operations": (0..4).map(|i| json!({"op":"spawn","client_id":format!("child-{i}"),"intent":format!("pending child {i}"),"delay_seconds":3600,"lifetime":"durable","objective":{"mode":"create","intent":"complete the replacement work","completion_criteria":"all four outputs verified"}})).collect::<Vec<_>>(), "group":{"policy":"all"}});
    // One explicit Objective binding for a shared group, rather than four
    // unrelated Objectives with coincidentally equal wording.
    let objective = runtime
        .inner
        .store
        .create_objective(NewObjective {
            id: "cancel-chain-objective".into(),
            agent_id: parent.agent_id.clone(),
            context_id: parent.context_id.clone(),
            coordinator_session_id: parent.session_id.clone(),
            delivery_session_id: parent.session_id.clone(),
            parent_objective_id: None,
            source_event_id: "fixture-objective".into(),
            initiating_principal_id: None,
            stated_objective: "four verified results".into(),
            token_budget: None,
        })
        .await
        .unwrap();
    let mut args = spawn();
    for op in args["operations"].as_array_mut().unwrap() {
        op["objective"] = json!({"mode":"existing","objective_id":objective.id});
    }
    let receipt = invoke(
        &runtime,
        &parent,
        "spawn-original",
        "schedule_tx",
        args.clone(),
    )
    .await;
    assert_eq!(receipt["status"], "committed");
    let schedules: Vec<ScheduleRecord> =
        serde_json::from_value(receipt["operations"].clone()).unwrap();
    assert_eq!(schedules.len(), 4);
    let group_id = receipt["thread_groups"][0]["group_id"].as_str().unwrap();
    let waiting = runtime
        .inner
        .store
        .get_objective(&objective.id)
        .await
        .unwrap()
        .unwrap();
    assert!(waiting.wait_condition.is_some());
    let dependency = runtime
        .inner
        .store
        .list_scheduler_dependencies(SchedulerDependencyFilter {
            owner_kind: Some(SchedulerDependencyOwnerKind::Objective),
            owner_id: Some(objective.id.clone()),
            status: Some(SchedulerDependencyStatus::Pending),
            ..Default::default()
        })
        .await
        .unwrap()
        .pop()
        .unwrap();
    let evaluation_id = "cancel-chain-interrupt";
    assert!(matches!(
        runtime
            .inner
            .store
            .claim_objective_interrupt_evaluation(
                &objective.id,
                waiting.revision,
                evaluation_id,
                chrono::Utc::now() + chrono::Duration::minutes(2),
                &dependency.id
            )
            .await
            .unwrap(),
        ObjectiveMutation::Updated(_)
    ));
    for schedule in &schedules {
        let timer_only = invoke(&runtime, &parent, "cancel-timer", "schedule_tx", json!({"operations":[{"op":"cancel","schedule_id":schedule.id,"expected_revision":schedule.revision}]})).await;
        assert_eq!(timer_only["scope"], "schedule");
        assert_eq!(timer_only["thread"]["lifecycle"], "open");
        assert!(timer_only["guidance"]
            .as_str()
            .unwrap()
            .contains("NOT cancelled"));
        let child = runtime
            .inner
            .store
            .get_thread(&schedule.thread_id)
            .await
            .unwrap()
            .unwrap();
        let args = json!({"thread_id":child.id,"expected_revision":child.revision,"action":"cancel","reason":"replace all four children"});
        let closed = invoke(
            &runtime,
            &parent,
            "cancel-work",
            "thread_control",
            args.clone(),
        )
        .await;
        assert_eq!(closed["thread"]["lifecycle"], "cancelled");
        let retry = invoke(
            &runtime,
            &parent,
            "cancel-work-replay",
            "thread_control",
            args,
        )
        .await;
        assert_eq!(retry["status"], "revision_conflict");
    }
    let group = runtime
        .inner
        .store
        .get_thread_group(group_id)
        .await
        .unwrap()
        .unwrap();
    assert!(group.status.is_terminal());
    assert_eq!(group.terminal_count, 4);
    assert_eq!(group.successful_count, 0);
    assert_eq!(
        runtime
            .inner
            .store
            .query(QueryFilter {
                event_id: group.barrier_event_id.clone(),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        1
    );
    let ready = runtime
        .inner
        .store
        .get_objective(&objective.id)
        .await
        .unwrap()
        .unwrap();
    assert!(ready.wait_condition.is_none());
    assert!(
        matches!(
            runtime
                .inner
                .store
                .renew_objective_interrupt_evaluation(
                    &objective.id,
                    evaluation_id,
                    chrono::Utc::now() + chrono::Duration::minutes(2),
                    &dependency.id
                )
                .await
                .unwrap(),
            ObjectiveMutation::Updated(_)
        ),
        "the same interrupt may continue after the exact group has settled"
    );
    for op in args["operations"].as_array_mut().unwrap() {
        op["delay_seconds"] = json!(0);
    }
    let replacement = invoke(&runtime, &parent, "spawn-replacement", "schedule_tx", args).await;
    assert_eq!(
        replacement["created_thread_ids"].as_array().unwrap().len(),
        4
    );
    drop(runtime);
    let reopened = Arc::new(
        crate::memory::sqlite::SqliteStore::new(&file.path().to_string_lossy())
            .await
            .unwrap(),
    );
    for schedule in &schedules {
        assert_eq!(
            reopened
                .get_thread(&schedule.thread_id)
                .await
                .unwrap()
                .unwrap()
                .lifecycle,
            ThreadLifecycle::Cancelled
        );
        assert_eq!(
            reopened
                .get_schedule(&schedule.id)
                .await
                .unwrap()
                .unwrap()
                .status,
            ScheduleStatus::Cancelled
        );
        assert_eq!(
            reopened
                .get_thread_outcome(&schedule.thread_id)
                .await
                .unwrap()
                .unwrap()
                .terminal_kind,
            ThreadLifecycle::Cancelled
        );
    }
    assert_eq!(
        reopened
            .get_thread_group(group_id)
            .await
            .unwrap()
            .unwrap()
            .terminal_count,
        4
    );
    let bus = Arc::new(crate::event::InMemoryEventBus::new());
    let timers = Arc::new(crate::timer::TimerEngine::new(reopened.clone()));
    let scheduler = Arc::new(crate::tool::ThreadScheduler::new(
        bus,
        reopened.clone(),
        reopened.clone(),
        timers.clone(),
    ));
    scheduler.register_timer_handler().unwrap();
    scheduler.recover().await.unwrap();
    assert_eq!(
        timers.dispatch_due_once().await.unwrap(),
        4,
        "only replacement schedules dispatch after scheduler reconstruction"
    );
    let signals = reopened
        .list_context_thread_signals(&parent.context_id, None)
        .await
        .unwrap();
    for id in replacement["created_thread_ids"].as_array().unwrap() {
        assert_eq!(
            signals
                .iter()
                .filter(|signal| signal.thread_id == id.as_str().unwrap())
                .count(),
            1
        );
    }
    for schedule in &schedules {
        assert!(
            !signals
                .iter()
                .any(|signal| signal.thread_id == schedule.thread_id),
            "cancelled children cannot resurrect on recovery"
        );
    }
    scheduler.recover().await.unwrap();
    assert_eq!(
        timers.dispatch_due_once().await.unwrap(),
        0,
        "recovery must not duplicate dispatch"
    );
}
