//! Stable embedded SDK facade for Morphz.
//!
//! The Runtime owns scheduling and persistence. This module owns the public
//! application contract used by CLI and HTTP adapters. Ingress adapters must
//! authenticate credentials before constructing a [`PrincipalAssertion`];
//! message text is never accepted as identity evidence.

use crate::event::Event;
use crate::identity::PrincipalAssertion;
use crate::memory::{
    CognitiveContextRecord, NewCognitiveContext, NewSession, QueryFilter, SessionRecord,
    SessionUpdate,
};
use crate::runtime::{MessageReceipt, MorphzRuntime, RuntimeEventStream};
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SdkErrorCode {
    InvalidArgument,
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    Internal,
}

impl SdkErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidArgument => "invalid_argument",
            Self::Unauthorized => "unauthorized",
            Self::Forbidden => "forbidden",
            Self::NotFound => "not_found",
            Self::Conflict => "conflict",
            Self::Internal => "internal",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SdkError {
    pub code: SdkErrorCode,
    pub message: String,
}

impl SdkError {
    pub fn new(code: SdkErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn internal(error: impl fmt::Display) -> Self {
        Self::new(SdkErrorCode::Internal, error.to_string())
    }
}

impl fmt::Display for SdkError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for SdkError {}

pub type SdkResult<T> = Result<T, SdkError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SendMessageCommand {
    pub session_id: String,
    pub text: String,
    pub actor: String,
    pub client_message_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionEventsQuery {
    pub session_id: String,
    pub after_sequence: Option<u64>,
    pub limit: usize,
}

/// A cloneable, transport-neutral application facade.
#[derive(Clone)]
pub struct MorphzSdk {
    runtime: MorphzRuntime,
}

impl MorphzSdk {
    pub fn new(runtime: MorphzRuntime) -> Self {
        Self { runtime }
    }

    pub fn default_principal(&self) -> PrincipalAssertion {
        PrincipalAssertion {
            principal_id: self.runtime.identity().principal_id.clone(),
            provider_id: "runtime-default".to_string(),
            assurance: "runtime-default".to_string(),
            display_name: None,
        }
    }

    pub async fn create_context(
        &self,
        context: NewCognitiveContext,
    ) -> SdkResult<CognitiveContextRecord> {
        self.runtime
            .create_context(context)
            .await
            .map_err(|error| SdkError::new(SdkErrorCode::Conflict, error.to_string()))
    }

    pub async fn create_session(
        &self,
        principal: PrincipalAssertion,
        session: NewSession,
    ) -> SdkResult<SessionRecord> {
        if let Some(parent_session_id) = session.parent_session_id.as_deref() {
            self.authorize_session(&principal.principal_id, parent_session_id)
                .await?;
        }
        self.runtime
            .create_session_for_principal(session, principal)
            .await
            .map_err(|error| SdkError::new(SdkErrorCode::Conflict, error.to_string()))
    }

    /// Explicitly binds a legacy Session after a trusted ingress has looked up
    /// its pre-existing ownership mapping. The SDK never guesses this mapping.
    pub async fn bind_existing_session(
        &self,
        principal: PrincipalAssertion,
        session_id: &str,
    ) -> SdkResult<SessionRecord> {
        let session = self
            .runtime
            .get_session(session_id)
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| {
                SdkError::new(
                    SdkErrorCode::NotFound,
                    format!("Session '{session_id}' 不存在"),
                )
            })?;
        self.runtime
            .bind_session_principal(session_id, principal)
            .await
            .map_err(SdkError::internal)?;
        Ok(session)
    }

    /// Makes every existing Session visible to the built-in Principal used by
    /// a single-user/default host. Existing historical bindings are preserved;
    /// only the current default binding is added when absent. This deliberately
    /// never runs in trusted-gateway mode, where only the gateway owns legacy
    /// Session ownership mappings.
    pub async fn adopt_sessions_for_default_principal(
        &self,
        principal: PrincipalAssertion,
        include_archived: bool,
    ) -> SdkResult<usize> {
        self.runtime
            .bind_all_sessions_to_principal(principal, include_archived)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn get_session(
        &self,
        principal_id: &str,
        session_id: &str,
    ) -> SdkResult<SessionRecord> {
        self.authorize_session(principal_id, session_id).await
    }

    pub async fn update_session(
        &self,
        principal_id: &str,
        session_id: &str,
        update: SessionUpdate,
    ) -> SdkResult<SessionRecord> {
        self.authorize_session(principal_id, session_id).await?;
        self.runtime
            .update_session(session_id, update)
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| {
                SdkError::new(
                    SdkErrorCode::NotFound,
                    format!("Session '{session_id}' 不存在"),
                )
            })
    }

    pub async fn list_sessions(
        &self,
        principal_id: &str,
        include_archived: bool,
    ) -> SdkResult<Vec<SessionRecord>> {
        self.runtime
            .list_principal_sessions(principal_id, include_archived)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn send_message(
        &self,
        principal: &PrincipalAssertion,
        command: SendMessageCommand,
    ) -> SdkResult<MessageReceipt> {
        self.authorize_session(&principal.principal_id, &command.session_id)
            .await?;
        self.runtime
            .session(command.session_id)
            .send_as_principal(
                command.text,
                command.actor,
                principal.principal_id.clone(),
                command.client_message_id,
            )
            .await
            .map_err(|error| SdkError::new(SdkErrorCode::InvalidArgument, error.to_string()))
    }

    pub async fn session_events(
        &self,
        principal_id: &str,
        query: SessionEventsQuery,
    ) -> SdkResult<Vec<Event>> {
        self.authorize_session(principal_id, &query.session_id)
            .await?;
        let limit = query.limit.clamp(1, 1_000);
        let filter = if let Some(after_sequence) = query.after_sequence {
            QueryFilter {
                session_id: Some(query.session_id),
                after_sequence: Some(after_sequence),
                top_k: Some(limit),
                excluded_topics: vec!["chat/context_inspect".to_string()],
                ..QueryFilter::default()
            }
        } else {
            QueryFilter {
                session_id: Some(query.session_id),
                latest_k: Some(limit),
                excluded_topics: vec!["chat/context_inspect".to_string()],
                ..QueryFilter::default()
            }
        };
        self.runtime
            .query_events(filter)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn authorize_session(
        &self,
        principal_id: &str,
        session_id: &str,
    ) -> SdkResult<SessionRecord> {
        let session = self
            .runtime
            .get_session(session_id)
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| {
                SdkError::new(
                    SdkErrorCode::NotFound,
                    format!("Session '{session_id}' 不存在"),
                )
            })?;
        let bound = self
            .runtime
            .verify_session_principal(session_id, principal_id)
            .await
            .map_err(SdkError::internal)?;
        if !bound {
            return Err(SdkError::new(
                SdkErrorCode::Forbidden,
                format!("Principal '{principal_id}' 未参与 Session '{session_id}'"),
            ));
        }
        Ok(session)
    }

    pub fn subscribe_all(&self, capacity: usize) -> RuntimeEventStream {
        self.runtime.subscribe("*", capacity)
    }

    pub async fn subscribe_session(
        &self,
        principal_id: &str,
        session_id: &str,
        capacity: usize,
    ) -> SdkResult<RuntimeEventStream> {
        self.authorize_session(principal_id, session_id).await?;
        Ok(self.runtime.subscribe("*", capacity))
    }

    /// Internal first-party adapters occasionally need Runtime-only surfaces
    /// which are intentionally not part of SDK v1 yet.
    #[doc(hidden)]
    pub fn runtime(&self) -> &MorphzRuntime {
        &self.runtime
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AppConfig;
    use crate::llm::{Client, Message, Response, ToolDefinition};
    use crate::memory::{NewAgent, SessionMountKind};
    use async_trait::async_trait;
    use std::sync::Arc;
    use tempfile::NamedTempFile;

    struct OfflineClient;

    #[async_trait]
    impl Client for OfflineClient {
        async fn create_completion(
            &self,
            _messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
            Err("offline".into())
        }
    }

    fn principal(id: &str) -> PrincipalAssertion {
        PrincipalAssertion {
            principal_id: id.to_string(),
            provider_id: "morphz-site".to_string(),
            assurance: "trusted-gateway".to_string(),
            display_name: Some(id.to_string()),
        }
    }

    #[tokio::test]
    async fn principal_scoped_contract_rejects_cross_session_access() {
        let database = NamedTempFile::new().unwrap();
        let runtime = MorphzRuntime::builder(AppConfig::default(), Arc::new(OfflineClient))
            .database_path(database.path().to_str().unwrap())
            .build()
            .await
            .unwrap();
        runtime
            .ensure_agent(NewAgent {
                id: "agent-sdk".to_string(),
                title: "SDK".to_string(),
                root_context_id: "context-sdk".to_string(),
            })
            .await
            .unwrap();
        runtime
            .ensure_context(NewCognitiveContext {
                id: "context-sdk".to_string(),
                agent_id: "agent-sdk".to_string(),
                title: "SDK".to_string(),
            })
            .await
            .unwrap();
        let sdk = MorphzSdk::new(runtime);
        sdk.create_session(
            principal("principal-a"),
            NewSession {
                id: "session-a".to_string(),
                agent_id: "agent-sdk".to_string(),
                context_id: "context-sdk".to_string(),
                parent_session_id: None,
                title: "A".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            },
        )
        .await
        .unwrap();

        assert_eq!(
            sdk.list_sessions("principal-a", false).await.unwrap().len(),
            1
        );
        let parent_error = sdk
            .create_session(
                principal("principal-b"),
                NewSession {
                    id: "session-b-child".to_string(),
                    agent_id: "agent-sdk".to_string(),
                    context_id: "context-sdk".to_string(),
                    parent_session_id: Some("session-a".to_string()),
                    title: "B child".to_string(),
                    mount_kind: SessionMountKind::ExistingContext,
                },
            )
            .await
            .unwrap_err();
        assert_eq!(parent_error.code, SdkErrorCode::Forbidden);

        let error = sdk
            .get_session("principal-b", "session-a")
            .await
            .unwrap_err();
        assert_eq!(error.code, SdkErrorCode::Forbidden);

        let default_principal = sdk.default_principal();
        assert_eq!(default_principal.principal_id, "principal-default");
        assert_eq!(
            sdk.adopt_sessions_for_default_principal(default_principal.clone(), true)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sdk.list_sessions(&default_principal.principal_id, false)
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            sdk.list_sessions("principal-a", false).await.unwrap().len(),
            1
        );
    }
}
