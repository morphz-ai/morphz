//! Physical Chat token-limit dialect. Do not use a model name to identify an
//! endpoint behind a compatible gateway, and do not retry a paid request just
//! to discover which parameter it accepts.

use crate::config::{ChatTokenLimitParameter, ModelProtocol, ProviderConfig};
use serde_json::Value;

pub(super) fn for_provider(provider: &ProviderConfig) -> ChatTokenLimitParameter {
    provider.chat_token_limit_parameter.unwrap_or_else(|| {
        // This is an exact, documented official endpoint, not a substring or
        // a guess based on the configured model/provider display name.
        if reqwest::Url::parse(&provider.base_url)
            .is_ok_and(|url| url.scheme() == "https" && url.host_str() == Some("api.deepseek.com"))
        {
            ChatTokenLimitParameter::MaxTokens
        } else {
            ChatTokenLimitParameter::MaxCompletionTokens
        }
    })
}

pub(super) fn adapt(
    mut request: Value,
    protocol: ModelProtocol,
    parameter: ChatTokenLimitParameter,
) -> Value {
    if protocol == ModelProtocol::OpenaiChat && parameter == ChatTokenLimitParameter::MaxTokens {
        if let Some(body) = request.as_object_mut() {
            if let Some(limit) = body.remove("max_completion_tokens") {
                body.insert("max_tokens".to_string(), limit);
            }
        }
    }
    request
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::LlmConfig;
    use crate::llm::{
        Client, Message, ModelFailure, ModelFailureKind, ModelStreamEvent, ToolDefinition,
    };
    use crate::provider::ProtocolClient;
    use axum::{routing::post, Json, Router};
    use serde_json::json;

    #[test]
    fn official_deepseek_chat_limit_is_not_inferred_from_the_model() {
        for base in [
            "https://api.deepseek.com",
            "https://api.deepseek.com/v1/",
            "https://api.deepseek.com/beta",
        ] {
            let provider = ProviderConfig {
                base_url: base.into(),
                ..Default::default()
            };
            let client = ProtocolClient::new(
                &provider,
                "any-physical-model".into(),
                None,
                &LlmConfig {
                    max_output_tokens: Some(32),
                    ..Default::default()
                },
            )
            .unwrap();
            let request = client.request_for_model("another-model", &[], &[]);
            assert_eq!(request["max_tokens"], 32, "{base}");
            assert!(request.get("max_completion_tokens").is_none());
        }
        for base in [
            "https://api.openai.com/v1",
            "https://gateway.invalid/v1",
            "https://api.deepseek.com.evil.invalid/v1",
            "https://api.deepseek.com@other.invalid/v1",
            "http://api.deepseek.com/v1",
        ] {
            let provider = ProviderConfig {
                base_url: base.into(),
                ..Default::default()
            };
            let client = ProtocolClient::new(
                &provider,
                "deepseek-flash".into(),
                None,
                &LlmConfig {
                    max_output_tokens: Some(32),
                    ..Default::default()
                },
            )
            .unwrap();
            let request = client.request_for_model("deepseek-flash", &[], &[]);
            assert_eq!(request["max_completion_tokens"], 32, "{base}");
            assert!(request.get("max_tokens").is_none());
        }
    }

    #[test]
    fn explicit_dialect_roundtrips_and_non_chat_protocols_do_not_change() {
        let provider: ProviderConfig = toml::from_str(
            "base_url='https://gateway.invalid/v1'\nchat_token_limit_parameter='max_tokens'",
        )
        .unwrap();
        assert_eq!(for_provider(&provider), ChatTokenLimitParameter::MaxTokens);
        assert_eq!(
            toml::from_str::<ProviderConfig>(&toml::to_string(&provider).unwrap())
                .unwrap()
                .chat_token_limit_parameter,
            provider.chat_token_limit_parameter
        );
        assert!(toml::from_str::<ProviderConfig>("chat_token_limit_parameter='guess'").is_err());
        for protocol in [
            ModelProtocol::OpenaiResponses,
            ModelProtocol::AnthropicMessages,
            ModelProtocol::GeminiContent,
        ] {
            let request = json!({"max_output_tokens":32,"max_tokens":32,"generationConfig":{"maxOutputTokens":32}});
            assert_eq!(
                adapt(
                    request.clone(),
                    protocol,
                    ChatTokenLimitParameter::MaxTokens
                ),
                request
            );
        }
        let official = ProviderConfig {
            base_url: "https://api.deepseek.com/v1".into(),
            chat_token_limit_parameter: Some(ChatTokenLimitParameter::MaxCompletionTokens),
            ..Default::default()
        };
        assert_eq!(
            for_provider(&official),
            ChatTokenLimitParameter::MaxCompletionTokens
        );
        assert_eq!(
            adapt(
                json!({"model":"x"}),
                ModelProtocol::OpenaiChat,
                ChatTokenLimitParameter::MaxTokens
            ),
            json!({"model":"x"})
        );
    }

    #[tokio::test]
    async fn compatible_chat_limit_reaches_the_actual_http_wire_with_tools_and_streaming() {
        let app = Router::new().route("/chat/completions", post(|Json(request): Json<Value>| async move {
            assert_eq!(request["max_tokens"], if request["stream"] == true {32} else {64});
            assert!(request.get("max_completion_tokens").is_none());
            assert_eq!(request["model"],"wire-model");
            if request["stream"] != true {
                return axum::response::Response::builder().header("content-type","application/json").body(axum::body::Body::from(json!({"choices":[{"message":{"content":"MORPHZ_OK"},"finish_reason":"stop"}]}).to_string())).unwrap();
            }
            assert_eq!(request["tools"][0]["function"]["name"],"read");
            axum::response::Response::builder().header("content-type","text/event-stream").body(axum::body::Body::from("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n")).unwrap()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = ProtocolClient::new(
            &ProviderConfig {
                base_url: format!("http://{address}"),
                chat_token_limit_parameter: Some(ChatTokenLimitParameter::MaxTokens),
                ..Default::default()
            },
            "wire-model".into(),
            None,
            &LlmConfig {
                max_output_tokens: Some(32),
                ..Default::default()
            },
        )
        .unwrap();
        client.probe_health().await.unwrap();
        let (stream, mut events) = tokio::sync::mpsc::unbounded_channel();
        let error = client
            .create_completion_measured_stream(
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
        let failure = error.downcast_ref::<ModelFailure>().unwrap();
        assert_eq!(failure.kind, ModelFailureKind::OutputLimit);
        assert!(!failure.kind.uses_provider_recovery());
        assert!(std::iter::from_fn(|| events.try_recv().ok()).any(
            |event| matches!(event, ModelStreamEvent::TextDelta { text } if text == "partial")
        ));
        server.abort();
    }

    #[test]
    fn routed_catalog_preserves_the_declared_limit_dialect() {
        use crate::config::{AppConfig, ProviderInstanceConfig};
        use crate::provider::routing::EffectiveProviderCatalog;
        let mut config = AppConfig::default();
        config.providers.insert(
            "legacy".into(),
            ProviderConfig {
                base_url: "https://gateway.invalid/v1".into(),
                chat_token_limit_parameter: Some(ChatTokenLimitParameter::MaxTokens),
                ..Default::default()
            },
        );
        config.provider_instances.insert(
            "routed".into(),
            ProviderInstanceConfig {
                base_url: "https://api.deepseek.com/v1".into(),
                chat_token_limit_parameter: Some(ChatTokenLimitParameter::MaxCompletionTokens),
                ..Default::default()
            },
        );
        let catalog = EffectiveProviderCatalog::from_config(&config).unwrap();
        assert_eq!(
            catalog.provider_instances["legacy"].chat_token_limit_parameter,
            Some(ChatTokenLimitParameter::MaxTokens)
        );
        assert_eq!(
            catalog.provider_instances["routed"].chat_token_limit_parameter,
            Some(ChatTokenLimitParameter::MaxCompletionTokens)
        );
    }
}
