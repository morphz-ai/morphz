//! Thin authenticated reads over Runtime's indexed discussion projections.
use super::*;

/// A transport read owner. Routes are immutable native projections and cached
/// only for this bounded connection; source bodies never enter this cache.
pub(super) struct ReadScope {
    pub selected: Option<crate::discussion::TimelineScope>,
    session: String,
    principal: Option<String>,
    routes: std::collections::HashMap<String, Option<crate::discussion::DiscussionRootRoute>>,
    order: std::collections::VecDeque<String>,
}
impl ReadScope {
    pub fn new(
        session: &str,
        principal: Option<String>,
        scope: Option<&str>,
        discussion: Option<&str>,
    ) -> Result<Self, &'static str> {
        let selected = match (scope, discussion) {
            (None, None) => None,
            (Some("main"), None) => Some(crate::discussion::TimelineScope::Main),
            (Some("discussion"), Some(id)) if !id.is_empty() && id.len() <= 128 => {
                Some(crate::discussion::TimelineScope::Discussion { id: id.into() })
            }
            _ => return Err("Invalid transport discussion scope"),
        };
        Ok(Self {
            selected,
            session: session.into(),
            principal,
            routes: Default::default(),
            order: Default::default(),
        })
    }
    pub async fn authorized(&self, state: &AppState) -> Result<(), crate::runtime::RuntimeError> {
        if self.selected.is_some() {
            if let Some(principal) = &self.principal {
                state
                    .sdk
                    .authorize_session(principal, &self.session)
                    .await?;
            }
        }
        Ok(())
    }
    pub async fn available(
        &self,
        runtime: &MorphzRuntime,
    ) -> Result<bool, crate::runtime::RuntimeError> {
        if let Some(crate::discussion::TimelineScope::Discussion { id }) = &self.selected {
            return Ok(runtime
                .session_discussion(&self.session, self.principal.as_deref(), id)
                .await?
                .is_some());
        }
        Ok(true)
    }
    pub fn filter(&self, filter: &mut QueryFilter) {
        match &self.selected {
            Some(crate::discussion::TimelineScope::Main) => filter.main_presentation_only = true,
            Some(crate::discussion::TimelineScope::Discussion { id }) => {
                filter.discussion_id = Some(id.clone())
            }
            None => {}
        }
    }
    pub async fn root(
        &mut self,
        runtime: &MorphzRuntime,
        root: &str,
    ) -> Result<bool, crate::runtime::RuntimeError> {
        if self.selected.is_none() {
            return Ok(true);
        }
        if root.is_empty() || root.len() > 512 {
            return Err("Invalid stream root identity".into());
        }
        if !self.routes.contains_key(root) {
            let route = runtime.discussion_root_route(&self.session, root).await?;
            self.routes.insert(root.into(), route);
            self.order.push_back(root.into());
            while self.order.len() > 512 {
                if let Some(id) = self.order.pop_front() {
                    self.routes.remove(&id);
                }
            }
        }
        let route = self.routes.get(root).and_then(Option::as_ref);
        Ok(match &self.selected {
            Some(crate::discussion::TimelineScope::Main) => {
                route.is_none_or(|route| route.main_visible)
            }
            Some(crate::discussion::TimelineScope::Discussion { id }) => {
                route.is_some_and(|route| {
                    &route.discussion_id == id
                        && self
                            .principal
                            .as_deref()
                            .is_none_or(|principal| principal == route.principal_id)
                })
            }
            None => true,
        })
    }
    pub async fn event(
        &mut self,
        runtime: &MorphzRuntime,
        event: &Event,
    ) -> Result<bool, crate::runtime::RuntimeError> {
        if self.selected.is_none() {
            return Ok(true);
        }
        let root = ["root_turn_id", "trigger_event_id", "source_turn_id"]
            .iter()
            .find_map(|key| event.payload.get(*key).and_then(serde_json::Value::as_str));
        if let Some(root) = root {
            return self.root(runtime, root).await;
        }
        if crate::event::is_input_event(event) {
            return self.root(runtime, &event.id).await;
        }
        Ok(matches!(
            self.selected,
            Some(crate::discussion::TimelineScope::Main)
        ))
    }
}

#[derive(serde::Deserialize)]
pub(super) struct ListQuery {
    #[serde(flatten)]
    auth: AuthQuery,
    source_key: String,
    before_time_micros: Option<i64>,
    before_id: Option<String>,
    limit: Option<usize>,
}

pub(super) async fn principal_scope(
    state: &AppState,
    headers: &HeaderMap,
    token: Option<&str>,
    principal: Option<&str>,
    session: &str,
) -> Result<Option<String>, Response> {
    if !is_authorized(state, headers, token) {
        return Err(unauthorized_response());
    }
    authorize_session_read(state, headers, token, principal, session)
        .await
        .map_err(sdk_error_response)?;
    if is_operator_authorized(state, headers, token) && principal.is_none() {
        Ok(None)
    } else {
        Ok(Some(
            request_read_principal(state, headers, token, principal)
                .map_err(sdk_error_response)?
                .principal_id,
        ))
    }
}

pub(super) async fn list(
    State(state): State<Arc<AppState>>,
    Path(session): Path<String>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Response {
    let principal = match principal_scope(
        &state,
        &headers,
        query.auth.token.as_deref(),
        query.auth.principal_id.as_deref(),
        &session,
    )
    .await
    {
        Ok(value) => value,
        Err(error) => return error,
    };
    if query.source_key.is_empty() || query.source_key.len() > 512 {
        return error_response(StatusCode::BAD_REQUEST, "A bounded source key is required");
    }
    let before = match (query.before_time_micros, query.before_id) {
        (None, None) => None,
        (Some(created_at_micros), Some(id)) if !id.is_empty() && id.len() <= 128 => {
            Some(crate::discussion::DiscussionCursor {
                created_at_micros,
                id,
            })
        }
        _ => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "A discussion cursor requires its time and identity",
            )
        }
    };
    let limit = query
        .limit
        .unwrap_or(20)
        .clamp(1, crate::discussion::MAX_PAGE_ROWS);
    match state
        .runtime
        .session_discussions(
            &session,
            principal.as_deref(),
            &query.source_key,
            before.as_ref(),
            limit + 1,
        )
        .await
    {
        Ok(mut items) => {
            let has_earlier = items.len() > limit;
            if has_earlier {
                items.pop();
            }
            let next_before = has_earlier.then(|| items.last()).flatten().map(|item| {
                crate::discussion::DiscussionCursor {
                    created_at_micros: item.created_at_micros,
                    id: item.id.clone(),
                }
            });
            Json(json!({"items":items,"next_before":next_before})).into_response()
        }
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[derive(serde::Deserialize)]
pub(super) struct DetailQuery {
    #[serde(flatten)]
    auth: AuthQuery,
    #[serde(default)]
    metadata_only: bool,
}

pub(super) async fn detail(
    State(state): State<Arc<AppState>>,
    Path((session, id)): Path<(String, String)>,
    headers: HeaderMap,
    Query(query): Query<DetailQuery>,
) -> Response {
    let principal = match principal_scope(
        &state,
        &headers,
        query.auth.token.as_deref(),
        query.auth.principal_id.as_deref(),
        &session,
    )
    .await
    {
        Ok(value) => value,
        Err(error) => return error,
    };
    if id.is_empty() || id.len() > 128 {
        return error_response(StatusCode::BAD_REQUEST, "Invalid discussion identity");
    }
    let discussion = match state
        .runtime
        .session_discussion(&session, principal.as_deref(), &id)
        .await
    {
        Ok(Some(value)) => value,
        Ok(None) => {
            return error_response(
                StatusCode::NOT_FOUND,
                "Discussion is unavailable in this scope",
            )
        }
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    if query.metadata_only {
        return Json(json!({"discussion":discussion})).into_response();
    }
    match state.runtime.session_message_event(&session, &id).await {
        Ok(Some(event)) if event.id == discussion.source_event_id => {
            match crate::discussion::from_event(&event) {
                Ok(Some(input)) if input.id == id && input.source.is_some() => {
                    Json(json!({"discussion":discussion,"source":input.source})).into_response()
                }
                _ => error_response(
                    StatusCode::CONFLICT,
                    "Discussion source projection does not match its accepted input",
                ),
            }
        }
        Ok(_) => error_response(
            StatusCode::CONFLICT,
            "Discussion's accepted source input is unavailable",
        ),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

pub(super) fn boundary_response(
    boundary: &crate::discussion::PageBudgetBoundary,
    text_only: bool,
) -> Response {
    Json(json!({"entries":[],"text_only":text_only,"next_before":{"visible_at_micros":boundary.visible_at_micros,"entry_id":boundary.entry_id},"content_boundary":{
        "entry_id":boundary.entry_id,"event_id":boundary.event_id,"root_turn_id":boundary.root_turn_id,"visible_at_micros":boundary.visible_at_micros,"display_kind":boundary.display_kind,"attempt_id":boundary.attempt_id,"final_event":boundary.final_event,"content_bytes":boundary.content_bytes,
    }})).into_response()
}
#[derive(serde::Deserialize)]
pub(super) struct MessageQuery {
    #[serde(flatten)]
    auth: AuthQuery,
    event_id: String,
    #[serde(default)]
    offset: i64,
}
pub(super) async fn message_chunk(
    State(state): State<Arc<AppState>>,
    Path((session, id, entry)): Path<(String, String, String)>,
    headers: HeaderMap,
    Query(query): Query<MessageQuery>,
) -> Response {
    let principal = match principal_scope(
        &state,
        &headers,
        query.auth.token.as_deref(),
        query.auth.principal_id.as_deref(),
        &session,
    )
    .await
    {
        Ok(principal) => principal,
        Err(error) => return error,
    };
    if id.is_empty()
        || id.len() > 128
        || entry.is_empty()
        || entry.len() > 256
        || query.event_id.is_empty()
        || query.event_id.len() > 512
        || query.offset < 0
        || query.offset > 10_000_000
    {
        return error_response(StatusCode::BAD_REQUEST, "Invalid message content boundary");
    }
    match state
        .runtime
        .discussion_message_chunk(
            &session,
            principal.as_deref(),
            &id,
            &entry,
            &query.event_id,
            query.offset,
        )
        .await
    {
        Ok(Some(chunk)) => Json(json!({"message":chunk})).into_response(),
        Ok(None) => error_response(
            StatusCode::CONFLICT,
            "This message changed; open its current content again",
        ),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}
