//! Real HTTP-boundary checks with an isolated synthetic upstream. These prove
//! the adapter sends the requested schema, not that every service enforces it.
use super::*;
use crate::llm::{ModelOutputEncoding, ModelRequestContext, ModelRequestOptions};
use axum::{
    body::Body, extract::State, http::StatusCode, response::Response as HttpResponse,
    routing::post, Json, Router,
};

fn prompt() -> Vec<Message> {
    vec![Message {
        role: "user".into(),
        content: "Synthetic structured output boundary test".into(),
        name: None,
        tool_call_id: None,
        tool_calls: None,
    }]
}

fn schema() -> Value {
    json!({"type":"object","additionalProperties":false,"required":["body"],
        "properties":{"body":{"type":"string"}}})
}

fn options() -> ModelRequestOptions {
    ModelRequestOptions {
        reasoning_effort: Some(Some(ReasoningEffort::Max)),
        output_encoding: Some(ModelOutputEncoding::JsonSchema {
            name: "session_io_test".into(),
            schema: schema(),
            strict: true,
        }),
    }
}

async fn binding(client: &dyn Client) -> ModelAttemptBinding {
    client
        .bind_model_attempt(&ModelRequestContext {
            context_id: "TEST-native-output".into(),
            session_id: "TEST-native-output".into(),
            attempt_id: "TEST-native-output".into(),
            objective_id: None,
            required_capabilities: vec![],
        })
        .await
        .unwrap()
}

#[derive(Clone)]
struct Upstream {
    requests: Arc<Mutex<Vec<Value>>>,
    rejection: bool,
    protocol: ModelProtocol,
}

async fn endpoint(State(state): State<Upstream>, Json(request): Json<Value>) -> HttpResponse {
    state.requests.lock().unwrap().push(request);
    if state.rejection {
        return HttpResponse::builder()
            .status(StatusCode::BAD_REQUEST)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error":{"type":"invalid_request_error",
                "message":"This response_format type is unavailable now"}})
                .to_string(),
            ))
            .unwrap();
    }
    // Deliberately preserve the observed DeepSeek counterexample: HTTP 200 and
    // completed do not imply that this scalar satisfies the requested object.
    let frames = if state.protocol == ModelProtocol::OpenaiResponses {
        vec![
            json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"5"}),
            json!({"type":"response.output_text.done","output_index":0,"content_index":0,"text":"5"}),
            json!({"type":"response.completed","response":{"status":"completed",
                "output":[{"type":"message","content":[{"type":"output_text","text":"5"}]}]}}),
        ]
    } else {
        vec![
            json!({"choices":[{"index":0,"delta":{"role":"assistant","content":"5"}}]}),
            json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}),
        ]
    };
    let mut wire = frames
        .into_iter()
        .map(|value| format!("data: {value}\n\n"))
        .collect::<String>();
    if state.protocol == ModelProtocol::OpenaiChat {
        wire.push_str("data: [DONE]\n\n");
    }
    HttpResponse::builder()
        .header("content-type", "text/event-stream")
        .body(Body::from(wire))
        .unwrap()
}

#[tokio::test]
async fn schema_is_on_the_actual_wire_without_schema_repair_or_retry() {
    for protocol in [ModelProtocol::OpenaiResponses, ModelProtocol::OpenaiChat] {
        for rejection in [false, true] {
            let requests = Arc::new(Mutex::new(vec![]));
            let upstream = Upstream {
                requests: requests.clone(),
                rejection,
                protocol,
            };
            let path = if protocol == ModelProtocol::OpenaiResponses {
                "/responses"
            } else {
                "/chat/completions"
            };
            let app = Router::new()
                .route(path, post(endpoint))
                .with_state(upstream);
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let client = ProtocolClient::new(
                &ProviderConfig {
                    protocol,
                    base_url: format!("http://{address}"),
                    ..Default::default()
                },
                "TEST-native-model".into(),
                None,
                &LlmConfig {
                    max_retries: 2,
                    initial_backoff_secs: 0,
                    ..Default::default()
                },
            )
            .unwrap();
            let binding = binding(&client).await;
            let tools = vec![ToolDefinition {
                name: "read_fixture".into(),
                description: "Read the isolated fixture".into(),
                parameters: json!({"type":"object","additionalProperties":false,"properties":{}}),
            }];
            let (stream, mut receiver) = tokio::sync::mpsc::unbounded_channel();
            let result = client
                .create_completion_bound_stream_with_options(
                    &binding,
                    prompt(),
                    tools.clone(),
                    None,
                    stream,
                    options(),
                )
                .await;
            let events = std::iter::from_fn(|| receiver.try_recv().ok()).collect::<Vec<_>>();
            let packets = requests.lock().unwrap();
            assert_eq!(
                packets.len(),
                1,
                "no schema downgrade, repair or semantic retry"
            );
            let packet = &packets[0];
            let format = if protocol == ModelProtocol::OpenaiResponses {
                assert_eq!(packet["reasoning"]["effort"], "max");
                &packet["text"]["format"]
            } else {
                assert_eq!(packet["reasoning_effort"], "max");
                assert_eq!(packet["response_format"]["type"], "json_schema");
                &packet["response_format"]["json_schema"]
            };
            assert_eq!(format["schema"], schema());
            assert_eq!(format["name"], "session_io_test");
            assert_eq!(format["strict"], true);
            assert_ne!(packet["tool_choice"], "none");
            assert_eq!(
                packet["tools"],
                client.request_for_model("TEST-native-model", &prompt(), &tools)["tools"]
            );
            if rejection {
                let error = result.unwrap_err();
                assert_eq!(
                    error.downcast_ref::<ModelFailure>().unwrap().kind,
                    ModelFailureKind::InvalidModelOrRequest
                );
                assert!(error
                    .to_string()
                    .contains("response_format type is unavailable"));
                assert!(events
                    .iter()
                    .any(|event| matches!(event, ModelStreamEvent::Failed { .. })));
                assert!(!events
                    .iter()
                    .any(|event| matches!(event, ModelStreamEvent::Completed)));
            } else {
                let response = result.unwrap();
                assert_eq!(
                    response.content, "5",
                    "do not coerce a scalar into a successful business result"
                );
                assert!(response.tool_calls.is_empty());
                let error = crate::session_io::schema::validate(
                    &schema(),
                    &crate::session_io::Data::parse(
                        response.content.as_bytes(),
                        &crate::session_io::Limits::default(),
                    )
                    .unwrap(),
                    "",
                )
                .unwrap_err();
                assert_eq!(
                    error.code, "schema_validation_failed",
                    "Session IO remains the value-validation authority"
                );
                assert_eq!(
                    events
                        .iter()
                        .filter_map(|event| match event {
                            ModelStreamEvent::TextDelta { text } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<String>(),
                    "5"
                );
            }
            drop(packets);
            server.abort();
            let _ = server.await;
        }
    }
}

struct UnsupportedClient;
#[async_trait::async_trait]
impl Client for UnsupportedClient {
    async fn create_completion(
        &self,
        _: Vec<Message>,
        _: Vec<ToolDefinition>,
    ) -> Result<Response, ProviderError> {
        panic!("a client must not execute after silently discarding a native schema")
    }
}

#[tokio::test]
async fn custom_client_cannot_silently_discard_a_native_schema() {
    let client = UnsupportedClient;
    let binding = binding(&client).await;
    let (stream, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let error = client
        .create_completion_bound_stream_with_options(
            &binding,
            prompt(),
            vec![],
            None,
            stream,
            options(),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("not silently discarded"));
    assert!(matches!(
        receiver.try_recv(),
        Ok(ModelStreamEvent::Failed { .. })
    ));
}
