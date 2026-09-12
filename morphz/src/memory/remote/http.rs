//! Authenticated, bounded coarse-grained RPC. The endpoint is operator
//! configuration; neither models nor request bodies choose a tenant or backend.
use super::protocol::*;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::time::Duration;

pub struct HttpRemoteStoreTransport {
    client: reqwest::Client,
    endpoint: reqwest::Url,
    authorization: reqwest::header::HeaderValue,
}

/// Same operator-selected HTTPS/private-binding policy as the Runtime Store,
/// but a separate protocol. It can publish observations, never grant readers.
pub struct HttpObserverTransport(HttpRemoteStoreTransport);
impl HttpObserverTransport {
    pub fn new(endpoint: &str, token: &str, private: bool) -> Result<Self, StoreError> {
        Ok(Self(if private {
            HttpRemoteStoreTransport::private_gateway(endpoint, token)?
        } else {
            HttpRemoteStoreTransport::new(endpoint, token)?
        }))
    }

    pub async fn publish(
        &self,
        fence: &Fence,
        batch: &super::host_observers::ObserverBatch,
    ) -> Result<super::host_observers::ObserverReceipt, StoreError> {
        use futures_util::StreamExt;
        let body = serde_json::to_vec(&json!({
            "protocol": "morphz-host-observers/1", "fence": fence, "batch": batch
        }))?;
        if body.len() > super::host_observers::MAX_OBSERVER_BATCH_BYTES + 4096 {
            return Err("observer request exceeds capacity".into());
        }
        for attempt in 0..3 {
            let response = self
                .0
                .client
                .post(self.0.endpoint.clone())
                .header(reqwest::header::AUTHORIZATION, self.0.authorization.clone())
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body.clone())
                .send()
                .await;
            match response {
                Ok(response) if response.status().is_success() => {
                    let mut stream = response.bytes_stream();
                    let mut bytes = Vec::new();
                    let mut interrupted = false;
                    while let Some(chunk) = stream.next().await {
                        let Ok(chunk) = chunk else {
                            interrupted = true;
                            break;
                        };
                        if bytes.len() + chunk.len() > 4096 {
                            return Err("observer receipt exceeds capacity".into());
                        }
                        bytes.extend_from_slice(&chunk);
                    }
                    if !interrupted {
                        return serde_json::from_slice(&bytes)
                            .map_err(|_| "invalid observer receipt".into());
                    }
                }
                Ok(response) if !response.status().is_server_error() => {
                    // No URL, gateway response body, event or credential in errors.
                    return Err(format!(
                        "observer publication rejected (HTTP {})",
                        response.status().as_u16()
                    )
                    .into());
                }
                _ => {}
            }
            if attempt < 2 {
                tokio::time::sleep(Duration::from_millis(100 * (1 << attempt))).await;
            }
        }
        Err("observer receipt unavailable; exact batch remains unacknowledged".into())
    }
}

impl HttpRemoteStoreTransport {
    pub fn new(endpoint: &str, token: &str) -> Result<Self, StoreError> {
        Self::build(endpoint, token, false)
    }

    /// Deployment-only transport over a platform-intercepted private HTTP
    /// binding. The embedding host, never a model, attests this network boundary.
    /// Ordinary remote endpoints continue to require HTTPS.
    pub fn private_gateway(endpoint: &str, token: &str) -> Result<Self, StoreError> {
        Self::build(endpoint, token, true)
    }

    fn build(endpoint: &str, token: &str, private: bool) -> Result<Self, StoreError> {
        let endpoint = reqwest::Url::parse(endpoint)?;
        if !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.fragment().is_some()
        {
            return Err("remote Store URL cannot contain credentials or a fragment".into());
        }
        let loopback = endpoint
            .host_str()
            .is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "[::1]"));
        if endpoint.scheme() != "https" && !(endpoint.scheme() == "http" && (loopback || private)) {
            return Err("remote Store requires HTTPS (HTTP is allowed only on loopback)".into());
        }
        if token.trim().is_empty() {
            return Err("remote Store credential is required".into());
        }
        let mut authorization = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))?;
        authorization.set_sensitive(true);
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .build()?;
        Ok(Self {
            client,
            endpoint,
            authorization,
        })
    }

    pub(crate) async fn rpc<T: DeserializeOwned>(
        &self,
        operation: &str,
        fence: &Fence,
        args: Value,
    ) -> Result<T, StoreError> {
        // Serialize once. Ambiguous network/5xx failures replay precisely the
        // same sequence and delta, never a freshly evaluated Store operation.
        let body = serde_json::to_vec(
            &json!({ "protocol": PROTOCOL, "operation": operation, "fence": fence, "args": args }),
        )?;
        for attempt in 0..3 {
            let response = self
                .client
                .post(self.endpoint.clone())
                .header(reqwest::header::AUTHORIZATION, self.authorization.clone())
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body.clone())
                .send()
                .await;
            match response {
                Ok(response) if response.status().is_success() => {
                    use futures_util::StreamExt;
                    let mut stream = response.bytes_stream();
                    let mut bytes = Vec::new();
                    while let Some(chunk) = stream.next().await {
                        let chunk = chunk.map_err(|_| {
                            "remote Store response interrupted; commit outcome unknown"
                        })?;
                        if bytes.len() + chunk.len() > MAX_COMMIT_BYTES {
                            return Err("remote Store response exceeded capacity".into());
                        }
                        bytes.extend_from_slice(&chunk);
                    }
                    return Ok(serde_json::from_slice(&bytes)?);
                }
                Ok(response) if !response.status().is_server_error() => {
                    // Never include a gateway HTML response or credential in a
                    // Runtime diagnostic. Non-5xx errors are not retried.
                    let status = response.status().as_u16();
                    let code = if response
                        .content_length()
                        .is_some_and(|length| length <= 1024)
                    {
                        response
                            .json::<Value>()
                            .await
                            .ok()
                            .and_then(|body| {
                                body.get("error").and_then(Value::as_str).map(str::to_owned)
                            })
                            .filter(|code| {
                                matches!(
                                    code.as_str(),
                                    "stale_compute_fence"
                                        | "store_schema_mismatch"
                                        | "store_revision_conflict"
                                        | "store_sequence_conflict"
                                        | "store_idempotency_conflict"
                                        | "store_record_capacity_exceeded"
                                        | "store_commit_capacity_exceeded"
                                        | "runtime_store_request_failed"
                                )
                            })
                    } else {
                        None
                    };
                    return Err(format!(
                        "remote Store {operation} rejected (HTTP {status}, {})",
                        code.as_deref().unwrap_or("request_rejected")
                    )
                    .into());
                }
                _ if attempt < 2 => {
                    tokio::time::sleep(Duration::from_millis(100 * (1 << attempt))).await
                }
                _ => {
                    return Err(
                        "remote Store unavailable; commit outcome may require recovery".into(),
                    )
                }
            }
        }
        unreachable!("bounded RPC loop returns on final attempt")
    }
}

#[async_trait::async_trait]
impl RemoteStoreTransport for HttpRemoteStoreTransport {
    async fn head(&self, fence: &Fence) -> Result<Head, StoreError> {
        self.rpc("head", fence, json!({})).await
    }
    async fn page(
        &self,
        fence: &Fence,
        revision: u64,
        after: Option<&str>,
    ) -> Result<Page, StoreError> {
        self.rpc(
            "page",
            fence,
            json!({ "revision": revision, "after": after }),
        )
        .await
    }
    async fn commit(&self, fence: &Fence, request: &Commit) -> Result<Head, StoreError> {
        self.rpc("commit", fence, json!({ "request": request }))
            .await
    }
}

#[async_trait::async_trait]
impl RemoteStoreLeaseTransport for HttpRemoteStoreTransport {
    async fn park(
        &self,
        fence: &Fence,
        revision: u64,
        next_wake_at_ms: Option<i64>,
    ) -> Result<ParkReceipt, StoreError> {
        self.rpc(
            "park",
            fence,
            json!({"revision":revision, "nextWakeAtMs":next_wake_at_ms}),
        )
        .await
    }
    async fn claim(&self, owner_id: &str) -> Result<Lease, StoreError> {
        self.rpc(
            "claim",
            &Fence {
                owner_id: owner_id.into(),
                epoch: 0,
            },
            json!({}),
        )
        .await
    }
    async fn renew(&self, fence: &Fence) -> Result<Lease, StoreError> {
        self.rpc("renew", fence, json!({})).await
    }
    async fn complete_recovery(&self, fence: &Fence) -> Result<(), StoreError> {
        let _: Value = self.rpc("recovered", fence, json!({})).await?;
        Ok(())
    }
}

#[cfg(test)]
mod observer_tests {
    use super::*;
    use axum::{body::Bytes, extract::State, http::StatusCode, routing::post, Router};
    use std::sync::{Arc, Mutex};

    type Requests = Arc<Mutex<Vec<Vec<u8>>>>;
    type ServerState = (Requests, Arc<Vec<(StatusCode, String)>>);
    async fn server(
        replies: Vec<(StatusCode, String)>,
    ) -> (String, Requests, tokio::task::JoinHandle<()>) {
        let requests: Requests = Arc::default();
        let state = (requests.clone(), Arc::new(replies));
        let router = Router::new()
            .route(
                "/observe",
                post(
                    |State((seen, replies)): State<ServerState>, body: Bytes| async move {
                        let mut seen = seen.lock().unwrap();
                        let index = seen.len();
                        seen.push(body.to_vec());
                        replies[index.min(replies.len() - 1)].clone()
                    },
                ),
            )
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/observe", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (url, requests, task)
    }
    fn batch() -> super::super::host_observers::ObserverBatch {
        super::super::host_observers::ObserverBatch {
            sequence: 3,
            events: vec![],
            reset: false,
        }
    }
    fn fence() -> Fence {
        Fence {
            owner_id: "synthetic-owner".into(),
            epoch: 2,
        }
    }

    #[tokio::test]
    async fn observer_http_retries_identical_serialized_batch_after_lost_ack() {
        let (url, seen, task) = server(vec![
            (StatusCode::BAD_GATEWAY, "lost receipt".into()),
            (StatusCode::OK, r#"{"epoch":2,"sequence":3}"#.into()),
        ])
        .await;
        let transport = HttpObserverTransport::new(&url, "synthetic-token", false).unwrap();
        let receipt = transport.publish(&fence(), &batch()).await.unwrap();
        assert_eq!((receipt.epoch, receipt.sequence), (2, 3));
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0], seen[1]);
        let body: Value = serde_json::from_slice(&seen[0]).unwrap();
        assert_eq!(body["protocol"], "morphz-host-observers/1");
        assert_eq!(body["fence"]["ownerId"], "synthetic-owner");
        task.abort();
    }
    #[tokio::test]
    async fn observer_http_does_not_retry_or_expose_denial_body() {
        let (url, seen, task) = server(vec![(
            StatusCode::FORBIDDEN,
            "private diagnostic must not appear".into(),
        )])
        .await;
        let error = HttpObserverTransport::new(&url, "synthetic-token", false)
            .unwrap()
            .publish(&fence(), &batch())
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "observer publication rejected (HTTP 403)"
        );
        assert_eq!(seen.lock().unwrap().len(), 1);
        task.abort();
    }
    #[tokio::test]
    async fn observer_http_receipt_is_bounded_and_malformed_payload_is_not_logged() {
        for (body, expected) in [
            ("x".repeat(4097), "observer receipt exceeds capacity"),
            (
                r#"{"private-field":"do not log"}"#.into(),
                "invalid observer receipt",
            ),
        ] {
            let (url, seen, task) = server(vec![(StatusCode::OK, body)]).await;
            let error = HttpObserverTransport::new(&url, "synthetic-token", false)
                .unwrap()
                .publish(&fence(), &batch())
                .await
                .unwrap_err();
            assert_eq!(error.to_string(), expected);
            assert_eq!(seen.lock().unwrap().len(), 1);
            task.abort();
        }
    }
    #[tokio::test]
    async fn observer_http_unavailable_remains_unacknowledged_after_bounded_retries() {
        let (url, seen, task) =
            server(vec![(StatusCode::SERVICE_UNAVAILABLE, "synthetic".into())]).await;
        let error = HttpObserverTransport::new(&url, "synthetic-token", false)
            .unwrap()
            .publish(&fence(), &batch())
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "observer receipt unavailable; exact batch remains unacknowledged"
        );
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 3);
        assert!(seen.windows(2).all(|pair| pair[0] == pair[1]));
        task.abort();
    }
    #[test]
    fn observer_http_requires_operator_selected_secure_transport() {
        assert!(
            HttpObserverTransport::new("http://external.invalid/observe", "synthetic", false)
                .is_err()
        );
        assert!(HttpObserverTransport::new(
            "https://user:password@external.invalid/observe",
            "synthetic",
            false
        )
        .is_err());
        assert!(HttpObserverTransport::new("https://external.invalid/observe", "", false).is_err());
    }
}
