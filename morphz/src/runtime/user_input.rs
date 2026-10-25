use super::*;

pub(super) fn question_reply_allowed(
    thread: &ThreadRecord,
    metadata: &serde_json::Value,
    request_id: &str,
    objective_edges: &[crate::scheduler::SchedulerDependencyRecord],
) -> bool {
    if thread.control_state != ThreadControlState::Active {
        return false;
    }
    let Some(objective_id) = metadata
        .get("objective_id")
        .and_then(serde_json::Value::as_str)
    else {
        return true;
    };
    objective_edges.iter().any(|edge| {
        edge.owner_id == objective_id
            && Some(edge.owner_generation)
                == metadata
                    .get("objective_generation")
                    .and_then(serde_json::Value::as_u64)
            && edge.dependency_id == request_id
            && edge
                .metadata
                .get("source")
                .and_then(serde_json::Value::as_str)
                == Some(crate::user_input::TOOL_NAME)
    })
}

impl MorphzRuntime {
    pub(super) async fn attach_user_input_requests(
        &self,
        context_id: &str,
        snapshots: &mut [SchedulerThreadSnapshot],
    ) -> Result<(), RuntimeError> {
        let ids = snapshots
            .iter()
            .filter(|snapshot| !snapshot.thread.lifecycle.is_terminal())
            .map(|snapshot| snapshot.thread.id.clone())
            .collect::<Vec<_>>();
        if ids.is_empty() {
            return Ok(());
        }
        let dependencies = self
            .inner
            .store
            .list_pending_user_input_dependencies(&ids)
            .await?;
        let event_ids = dependencies
            .iter()
            .filter(|edge| {
                edge.metadata
                    .get("source")
                    .and_then(serde_json::Value::as_str)
                    == Some(crate::user_input::TOOL_NAME)
            })
            .map(|edge| edge.dependency_id.clone())
            .collect::<Vec<_>>();
        // An empty exact-ID filter means an unbounded query to EventStore.
        if event_ids.is_empty() {
            return Ok(());
        }
        if event_ids.len() > ids.len() {
            return Err("More than one pending question exists for a selected Thread".into());
        }
        let events = self
            .inner
            .store
            .query(QueryFilter {
                context_id: Some(context_id.into()),
                event_ids,
                topic: Some(crate::user_input::REQUEST_TOPIC.into()),
                ..Default::default()
            })
            .await?
            .into_iter()
            .map(|event| (event.id.clone(), event))
            .collect::<HashMap<_, _>>();
        let objective_ids = events
            .values()
            .filter_map(|event| {
                event
                    .payload
                    .get("objective_id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let objective_edges = self
            .inner
            .store
            .list_active_objective_user_input_dependencies(&objective_ids)
            .await?;
        for snapshot in snapshots {
            for edge in dependencies.iter().filter(|edge| {
                edge.owner_id == snapshot.thread.id
                    && edge.owner_generation == snapshot.thread.generation
            }) {
                if edge
                    .metadata
                    .get("source")
                    .and_then(serde_json::Value::as_str)
                    != Some(crate::user_input::TOOL_NAME)
                {
                    continue;
                }
                let event = events
                    .get(&edge.dependency_id)
                    .ok_or("Pending question Event is missing from its Context")?;
                snapshot.user_input_request =
                    crate::user_input::pending_request(&snapshot.thread, edge, event)?;
                if let Some(question) = snapshot.user_input_request.as_mut() {
                    if !question_reply_allowed(
                        &snapshot.thread,
                        &serde_json::to_value(&event.payload)?,
                        &question.request_id,
                        &objective_edges,
                    ) {
                        question.reply_allowed = Some(false);
                    }
                }
                if snapshot.user_input_request.is_some()
                    && matches!(snapshot.phase, ThreadPhase::Idle | ThreadPhase::Runnable)
                {
                    snapshot.phase = ThreadPhase::Waiting;
                }
            }
        }
        Ok(())
    }
}
