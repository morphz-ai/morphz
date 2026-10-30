//! Exercise both catalog input formats through the real routed HTTP/SSE client.
use axum::{body::Body, routing::post, Json, Router};
use morphz::{
    config::AppConfig,
    llm::{Message, ModelFailure, ModelFailureKind, ModelRequestContext, ToolDefinition},
    provider::build_configured_client,
};
use serde_json::{json, Value};

#[tokio::test]
async fn configured_chat_dialect_survives_legacy_and_routed_account_binding_on_the_wire() {
    async fn completion(Json(request): Json<Value>) -> axum::response::Response {
        assert_eq!(request["max_tokens"], 32);
        assert!(request.get("max_completion_tokens").is_none());
        assert_eq!(request["model"], "physical-canary");
        assert_eq!(request["tools"][0]["function"]["name"], "read");
        axum::response::Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from(concat!(
                "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":\"length\"}]}\n\n",
                "data: [DONE]\n\n"
            )))
            .unwrap()
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().route("/chat/completions", post(completion));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    for legacy in [true, false] {
        let catalog = if legacy {
            format!(
                r#"
                [llm]
                provider = "wire"
                model = "physical-canary"
                [providers.wire]
                protocol = "openai-chat"
                base_url = "http://{address}"
                chat_token_limit_parameter = "max_tokens"
            "#
            )
        } else {
            format!(
                r#"
                [llm]
                model = "logical-route"
                [services.wire]
                adapter = "openai-compatible"
                protocol = "openai-chat"
                base_url = "http://{address}"
                chat_token_limit_parameter = "max_tokens"
                accounts = ["anonymous"]
                [accounts.anonymous]
                auth_adapter = "none"
                provider = "wire"
                [models.logical-route]
                service = "wire"
                physical_model = "physical-canary"
            "#
            )
        };
        let mut config: AppConfig = toml::from_str(&catalog).unwrap();
        config.llm.max_output_tokens = Some(32);
        config.llm.max_retries = 1;
        let (client, _) = build_configured_client(&config, None, None).unwrap();
        let binding = client
            .bind_model_attempt(&ModelRequestContext {
                context_id: "synthetic-dialect".into(),
                session_id: "synthetic-dialect".into(),
                attempt_id: format!("synthetic-dialect-{legacy}"),
                objective_id: None,
                required_capabilities: vec![],
            })
            .await
            .unwrap();
        let (stream, _events) = tokio::sync::mpsc::unbounded_channel();
        let error = client
            .create_completion_bound_stream(
                &binding,
                vec![Message {
                    role: "user".into(),
                    content: "synthetic canary".into(),
                    name: None,
                    tool_call_id: None,
                    tool_calls: None,
                }],
                vec![ToolDefinition {
                    name: "read".into(),
                    description: "synthetic read".into(),
                    parameters: json!({"type":"object"}),
                }],
                None,
                stream,
            )
            .await
            .unwrap_err();
        assert_eq!(
            error.downcast_ref::<ModelFailure>().unwrap().kind,
            ModelFailureKind::OutputLimit,
            "legacy={legacy}"
        );
    }
    server.abort();
}
