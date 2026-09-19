//! HTTP adapter for experimental typed Session IO. Credentials never come from URLs.
use super::*;
use crate::session_io::{self, Data, IoError, Subscription};
use std::time::Duration;

pub(super) fn io_error(error: IoError) -> Response {
    (
        StatusCode::from_u16(error.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(json!({"error":error})),
    )
        .into_response()
}

fn principal(state: &AppState, headers: &HeaderMap) -> Result<PrincipalAssertion, Box<Response>> {
    if !is_authorized(state, headers, None) {
        return Err(Box::new(unauthorized_response()));
    }
    request_principal(state, headers, None).map_err(|error| Box::new(sdk_error_response(error)))
}

pub(super) async fn capabilities(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = principal(&state, &headers) {
        return *error;
    }
    let mut capabilities = state.runtime.session_io_registry().capabilities();
    // Report the live registry, not persisted packages that this process has
    // not loaded. Exact refs only: no contracts, credentials or installation.
    capabilities["harnesses"] = json!(state
        .sdk
        .list_harnesses()
        .into_iter()
        .map(|h| json!({"id": h.id, "version": h.version}))
        .collect::<Vec<_>>());
    Json(capabilities).into_response()
}

pub(super) async fn resource(
    State(state): State<Arc<AppState>>,
    Path((session, resource)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let principal = match principal(&state, &headers) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    match state
        .sdk
        .read_io_resource(&principal, &session, &resource)
        .await
    {
        Ok((_, attachment)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header(header::CONTENT_DISPOSITION, "attachment")
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .body(Body::from(attachment.data))
            .expect("fixed resource response headers"),
        Err(error) => io_error(error),
    }
}

pub(super) async fn message_page(
    State(state): State<Arc<AppState>>,
    Path((session, event)): Path<(String, String)>,
    headers: HeaderMap,
    query: Result<
        Query<session_io::projection::PageQuery>,
        axum::extract::rejection::QueryRejection,
    >,
) -> Response {
    let principal = match principal(&state, &headers) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let query = match query {
        Ok(Query(query)) => query,
        Err(error) => return error.into_response(),
    };
    match state
        .sdk
        .read_io_message_page(&principal, &session, &event, &query)
        .await
    {
        Ok(page) => (
            [
                (header::CONTENT_TYPE, "application/json"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            page.json(),
        )
            .into_response(),
        Err(error) => io_error(error),
    }
}

pub(super) async fn send(
    State(state): State<Arc<AppState>>,
    Path(session): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let principal = match principal(&state, &headers) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let limits = &state.runtime.session_io_registry().limits;
    let bytes = match axum::body::to_bytes(body, limits.max_bytes).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return io_error(IoError::new(
                "message_limit_exceeded",
                "Input exceeds the declared byte limit",
            ))
        }
    };
    let request = match session_io::Request::parse(&bytes, limits) {
        Ok(value) => value,
        Err(error) => return io_error(error),
    };
    match state
        .sdk
        .send_io_message(&principal, &session, request)
        .await
    {
        Ok(event) => Json(
            json!({"io_version":"1","status":"accepted","accepted":true,"message_id":event.id,"event_id":event.id,
            "session_id":session,"cursor":cursor(&session, event.sequence.unwrap_or(0)),
            "binding":event.payload.get("session_io").and_then(|io| io.get("binding"))}),
        )
        .into_response(),
        Err(error) => io_error(error),
    }
}

#[derive(Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReadQuery {
    after: Option<String>,
    io_version: Option<String>,
    stream_version: Option<String>,
    receive_formats: Option<String>,
    receive_unknown: Option<String>,
}
impl ReadQuery {
    fn preferences(&self) -> session_io::IoResult<Subscription> {
        Subscription {
            io_version: self.io_version.clone().unwrap_or("1".into()),
            stream_version: self.stream_version.clone().unwrap_or("1".into()),
            receive_formats: self
                .receive_formats
                .as_ref()
                .map(|value| {
                    serde_json::from_str(value).map_err(|_| {
                        IoError::new("invalid_content_syntax", "Invalid receive_formats list")
                    })
                })
                .transpose()?,
            receive_unknown: self.receive_unknown.clone().unwrap_or("inspect".into()),
        }
        .normalize()
    }
}

fn cursor(session: &str, sequence: u64) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&(session, sequence)).expect("cursor serialization"))
}
fn sequence(session: &str, encoded: Option<&str>) -> session_io::IoResult<u64> {
    let Some(encoded) = encoded else {
        return Ok(0);
    };
    let error = || {
        IoError::new(
            "invalid_content_syntax",
            "Cursor is invalid for this Session",
        )
    };
    if encoded.len() > 2048 {
        return Err(error());
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| error())?;
    let (owner, sequence): (String, u64) = serde_json::from_slice(&bytes).map_err(|_| error())?;
    if owner != session {
        return Err(error());
    }
    Ok(sequence)
}

/// Format-specific render support is independent of permission and delivery.
fn event_wire(event: &Event, preferences: &Subscription) -> Option<(String, String)> {
    let input = event
        .payload
        .get("session_io")
        .cloned()
        .and_then(|value| serde_json::from_value::<session_io::AcceptedInput>(value).ok());
    let output = event
        .payload
        .get("io_message")
        .cloned()
        .and_then(|value| serde_json::from_value::<session_io::Message>(value).ok());
    let (kind, message) = if let Some(input) = input.as_ref() {
        ("input.accepted", Some(input.request.message.clone()))
    } else if let Some(output) = output {
        ("output.committed", Some(output))
    } else if crate::event::is_input_event(event) || event.topic == "chat/reply" {
        let message = session_io::standard_chat_event(event)?;
        (
            if crate::event::is_input_event(event) {
                "input.accepted"
            } else {
                "output.committed"
            },
            Some(message),
        )
    } else if event.topic.starts_with("runtime/thread")
        || event.topic.starts_with("session/io_")
        || event.topic == "chat/no_reply"
        || event.topic == "chat/cancelled"
        || event.topic == "chat/runtime_error"
    {
        ("run.state", None)
    } else if ["chat/tool_output", "chat/assistant_call"].contains(&event.topic.as_str())
        || event.topic.starts_with("runtime/execution")
        || event.topic.starts_with("runtime/approval")
    {
        ("execution.event", None)
    } else {
        return None;
    };
    let mut base = BTreeMap::from([
        ("io_version".into(), Data::String("1".into())),
        ("type".into(), Data::String(kind.into())),
        ("event_id".into(), Data::String(event.id.clone())),
        (
            "timestamp".into(),
            Data::String(event.timestamp.to_rfc3339()),
        ),
        (
            "sequence".into(),
            Data::Number(event.sequence.unwrap_or_default().to_string()),
        ),
    ]);
    base.insert("source".into(), Data::from_value(&json!({"kind":if kind == "input.accepted" {"client"} else if kind == "output.committed" {"agent"} else {"runtime"},"actor":event.actor})));
    if message.is_some() {
        base.insert("message_id".into(), Data::String(event.id.clone()));
    }
    for name in [
        "session_id",
        "principal_id",
        "root_turn_id",
        "thread_id",
        "activation_id",
        "model_attempt_id",
        "output_id",
    ] {
        if let Some(value) = crate::memory::causal_payload_string(event, name) {
            base.insert(name.into(), Data::String(value.into()));
        }
    }
    let mut disclose_binding = true;
    if let Some(message) = message {
        let known = preferences.receive_formats.as_ref().is_some_and(|formats| {
            formats.iter().any(|format| {
                format.id == message.format.id
                    && format.version == message.format.version
                    && format.encoding == message.content.encoding()
            })
        });
        base.insert(
            "presentation".into(),
            Data::String(
                if known {
                    "native"
                } else if preferences.receive_unknown == "inspect" {
                    "inspect"
                } else {
                    "unsupported-format"
                }
                .into(),
            ),
        );
        if known || preferences.receive_unknown == "inspect" {
            base.insert("message".into(), message.wire_data());
        } else {
            disclose_binding = false;
            base.insert(
                "format".into(),
                Data::String(format!("{}@{}", message.format.id, message.format.version)),
            );
        }
    } else {
        base.insert("event".into(), Data::from_value(&json!(event)));
    }
    if let Some(input) = input.filter(|_| disclose_binding) {
        base.insert("binding".into(), Data::from_value(&json!(input.binding)));
    } else if disclose_binding {
        let resources = session_io::resources::event_resources(event);
        if !resources.is_empty() {
            base.insert("resources".into(), Data::from_value(&json!(resources)));
        }
    }
    Some((kind.into(), Data::Object(base).json()))
}

pub(super) async fn events(
    State(state): State<Arc<AppState>>,
    Path(session): Path<String>,
    headers: HeaderMap,
    Query(query): Query<ReadQuery>,
) -> Response {
    let principal = match principal(&state, &headers) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    if let Err(error) = state
        .sdk
        .authorize_session(&principal.principal_id, &session)
        .await
    {
        return sdk_error_response(error);
    }
    let preferences = match query.preferences() {
        Ok(value) => value,
        Err(error) => return io_error(error),
    };
    let after = match sequence(&session, query.after.as_deref()) {
        Ok(value) => value,
        Err(error) => return io_error(error),
    };
    let events = match state
        .runtime
        .query_events(QueryFilter {
            session_id: Some(session.clone()),
            after_sequence: Some(after),
            top_k: Some(256),
            ..Default::default()
        })
        .await
    {
        Ok(value) => value,
        Err(_) => {
            return io_error(IoError::new(
                "unavailable",
                "Cannot read durable IO history",
            ))
        }
    };
    let next = events
        .iter()
        .filter_map(|event| event.sequence)
        .max()
        .unwrap_or(after);
    let values = events
        .iter()
        .filter_map(|event| event_wire(event, &preferences).map(|(_, value)| value))
        .collect::<Vec<_>>();
    let body = format!(
        "{{\"subscription\":{},\"events\":[{}],\"cursor\":{}}}",
        serde_json::to_string(&preferences).expect("subscription"),
        values.join(","),
        serde_json::to_string(&cursor(&session, next)).expect("cursor")
    );
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}

pub(super) async fn stream(
    State(state): State<Arc<AppState>>,
    Path(session): Path<String>,
    headers: HeaderMap,
    Query(query): Query<ReadQuery>,
) -> Response {
    use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
    let principal = match principal(&state, &headers) {
        Ok(value) => value,
        Err(error) => return *error,
    };
    let preferences = match query.preferences() {
        Ok(value) => value,
        Err(error) => return io_error(error),
    };
    let after = query.after.as_deref().or_else(|| {
        headers
            .get("last-event-id")
            .and_then(|value| value.to_str().ok())
    });
    let mut after = match sequence(&session, after) {
        Ok(value) => value,
        Err(error) => return io_error(error),
    };
    let mut live = match state
        .sdk
        .subscribe_session(&principal.principal_id, &session, 256)
        .await
    {
        Ok(value) => value,
        Err(error) => return sdk_error_response(error),
    };
    let (sender, receiver) =
        tokio::sync::mpsc::channel::<Result<SseEvent, std::convert::Infallible>>(64);
    tokio::spawn(async move {
        let opened = json!({"type":"stream.opened","subscription":preferences,"cursor":cursor(&session, after)});
        if sender
            .send(Ok(SseEvent::default()
                .event("stream.opened")
                .data(opened.to_string())))
            .await
            .is_err()
        {
            return;
        }
        let mut interval = tokio::time::interval(Duration::from_millis(250));
        let mut first = true;
        let mut seen = HashMap::<String, u64>::new();
        let mut terminal_roots = std::collections::HashSet::<String>::new();
        loop {
            // Bound per-connection history as well as draft storage. Clients
            // reconnect with the last durable cursor after this explicit reset.
            if seen.len() > 4096 || terminal_roots.len() > 4096 {
                let reset = json!({"type":"stream.reset","reason":"connection_history_limit","cursor":cursor(&session,after)});
                let _ = sender
                    .send(Ok(SseEvent::default()
                        .event("stream.reset")
                        .data(reset.to_string())))
                    .await;
                return;
            }
            let incoming = tokio::select! {
                _ = sender.closed() => return,
                _ = interval.tick() => None,
                event = live.recv() => match event {Some(event) => Some(event), None => return},
            };
            if state
                .sdk
                .authorize_session(&principal.principal_id, &session)
                .await
                .is_err()
            {
                return;
            }
            // Drain the durable gap before transient drafts. This recovers dropped
            // notifications and fences late deltas after committed terminal state.
            loop {
                if state
                    .sdk
                    .authorize_session(&principal.principal_id, &session)
                    .await
                    .is_err()
                {
                    return;
                }
                let records = match state
                    .runtime
                    .query_events(QueryFilter {
                        session_id: Some(session.clone()),
                        after_sequence: Some(after),
                        top_k: Some(256),
                        ..Default::default()
                    })
                    .await
                {
                    Ok(events) => events,
                    Err(_) => return,
                };
                let count = records.len();
                for event in records {
                    after = after.max(event.sequence.unwrap_or(after));
                    if matches!(
                        event.topic.as_str(),
                        "chat/reply" | "chat/no_reply" | "chat/cancelled" | "session/io_state"
                    ) || event.payload.get("terminal_kind").is_some()
                    {
                        if let Some(root) = event
                            .payload
                            .get("root_turn_id")
                            .and_then(serde_json::Value::as_str)
                        {
                            terminal_roots.insert(root.into());
                        }
                    }
                    if let Some((kind, data)) = event_wire(&event, &preferences) {
                        if sender
                            .send(Ok(SseEvent::default()
                                .event(kind)
                                .id(cursor(&session, after))
                                .data(data)))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                }
                if count < 256 {
                    break;
                }
            }
            let can_inspect_chat = preferences.receive_unknown == "inspect"
                || preferences.receive_formats.as_ref().is_some_and(|formats| {
                    formats
                        .iter()
                        .any(|format| format.id == "morphz.chat" && format.version == "1")
                });
            if !can_inspect_chat {
                continue;
            }
            if first || incoming.is_none() {
                // Reconnect does not replay deltas as new text. Snapshots replace a
                // draft up to delta_seq and are never output.committed.
                for snapshot in state.runtime.session_io_snapshots(&session) {
                    if terminal_roots
                        .contains(snapshot["root_turn_id"].as_str().unwrap_or_default())
                    {
                        continue;
                    }
                    let id = snapshot["output_id"].as_str().unwrap_or_default();
                    let seq = snapshot["delta_seq"].as_u64().unwrap_or_default();
                    if seen.get(id).is_some_and(|previous| *previous >= seq) {
                        continue;
                    }
                    if seen.contains_key(id) {
                        let reset = json!({"type":"stream.reset","output_id":id,"reason":"draft_sequence_gap","cursor":cursor(&session,after)});
                        if sender
                            .send(Ok(SseEvent::default()
                                .event("stream.reset")
                                .data(reset.to_string())))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                    seen.insert(id.into(), seq);
                    if sender
                        .send(Ok(SseEvent::default()
                            .event("output.started")
                            .data(snapshot.to_string())))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                first = false;
            }
            if let Some(update) = incoming
                .as_ref()
                .and_then(|event| event.payload.get("session_io_stream"))
            {
                if terminal_roots.contains(update["root_turn_id"].as_str().unwrap_or_default()) {
                    continue;
                }
                let id = update["output_id"].as_str().unwrap_or_default();
                let seq = update["delta_seq"].as_u64().unwrap_or_default();
                let previous = seen.get(id).copied();
                let kind = update["type"].as_str().unwrap_or_default();
                if kind == "output.delta" && previous.is_some_and(|previous| seq <= previous) {
                    continue;
                }
                if kind == "output.delta" && seq != previous.unwrap_or_default() + 1 {
                    let reset = json!({"type":"stream.reset","output_id":id,"reason":"draft_sequence_gap","cursor":cursor(&session,after)});
                    if sender
                        .send(Ok(SseEvent::default()
                            .event("stream.reset")
                            .data(reset.to_string())))
                        .await
                        .is_err()
                    {
                        return;
                    }
                    if let Some(snapshot) = state
                        .runtime
                        .session_io_snapshots(&session)
                        .into_iter()
                        .find(|snapshot| snapshot["output_id"] == id)
                    {
                        seen.insert(
                            id.into(),
                            snapshot["delta_seq"].as_u64().unwrap_or_default(),
                        );
                        if sender
                            .send(Ok(SseEvent::default()
                                .event("output.started")
                                .data(snapshot.to_string())))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                    continue;
                }
                seen.insert(id.into(), seq);
                if sender
                    .send(Ok(SseEvent::default().event(kind).data(update.to_string())))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        }
    });
    let events = futures_util::stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|event| (event, receiver))
    });
    Sse::new(events)
        .keep_alive(KeepAlive::default())
        .into_response()
}
