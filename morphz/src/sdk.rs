//! Stable embedded SDK facade for Morphz.
//!
//! The Runtime owns scheduling and persistence. This module owns the public
//! application contract used by CLI and HTTP adapters. Ingress adapters must
//! authenticate credentials before constructing a [`PrincipalAssertion`];
//! message text is never accepted as identity evidence.

use crate::event::Event;
use crate::execution::JobReceipt;
pub use crate::harness::ExactHarnessRef;
use crate::harness::{HarnessBinding, HarnessDescriptor};
use crate::harness_package::HarnessPackage;
use crate::identity::PrincipalAssertion;
use crate::memory::{
    CapabilityLeaseFilter, CapabilityLeaseMutation, CapabilityLeaseRecord, CognitiveContextRecord,
    ContextUpdate, EdgeCommandMutation, EdgeCommandOutputChunk, EdgeCommandRecord,
    EdgeCommandStatus, EdgeOutputStream, ExecutionJobFilter, ExecutionJobRecord,
    ExecutionJobStatus, ExecutionNodeMutation, ExecutionNodeRecord, ExecutionNodeStatus,
    ExecutionTargetAuthorizationFilter, ExecutionTargetAuthorizationMutation,
    ExecutionTargetAuthorizationRecord, ExecutionTargetAuthorizationScope, ExecutionTargetFilter,
    ExecutionTargetKind, ExecutionTargetMutation, ExecutionTargetRecord,
    ExecutionTargetRegistration, ExecutionTargetStatus, NewCognitiveContext,
    NewExecutionNodeChallenge, NewExecutionTargetAuthorization, NewNodePairingCode, NewObjective,
    NewSession, ObjectiveRecord, PairExecutionNode, QueryFilter, SessionRecord, SessionUpdate,
};
use crate::orchestrator::context::MindProjectionAudit;
use crate::runtime::{
    AcknowledgeAttentionCommand, AttentionAcknowledgement, ContextOverview, ContextOverviewQuery,
    DialogueTurnRetryReceipt, LedgerQuery, LedgerQueryPage, MessageReceipt, ModelUsagePage,
    ModelUsageQuery, MorphzRuntime, RuntimeEventStream, RuntimeStatus, SchedulerQuery,
    SchedulerSnapshot, ThreadDetail,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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
    /// Optional exact Harness selection for this ordinary Evaluation. Omit to
    /// let the model either answer normally or discover/select one lazily.
    #[serde(default)]
    pub harness: Option<crate::harness::ExactHarnessRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RetryDialogueTurnCommand {
    pub session_id: String,
    pub root_turn_id: String,
    pub expected_thread_revision: u64,
    pub expected_result_event_id: String,
    /// Caller-generated idempotency key. Retrying the HTTP request with the
    /// same key returns the same logical restart instead of advancing another
    /// generation.
    pub retry_request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionEventsQuery {
    pub session_id: String,
    pub after_sequence: Option<u64>,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreateNodePairingCodeCommand {
    /// Short-lived authority only. The SDK clamps this to 1..=900 seconds.
    pub expires_in_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NodePairingCode {
    pub code: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PairExecutionNodeCommand {
    pub code: String,
    pub node_id: Option<String>,
    pub name: String,
    pub device_key_fingerprint: String,
    /// Hex-encoded Ed25519 public key generated and retained by the Node.
    pub device_public_key: String,
    pub protocol_version: u32,
    pub platform: Option<String>,
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PairedExecutionNode {
    pub node: ExecutionNodeRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionNodeIdentityChallenge {
    pub challenge_id: String,
    pub nonce: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConnectExecutionNodeCommand {
    pub challenge_id: String,
    pub nonce: String,
    /// Hex-encoded Ed25519 signature over the canonical connection proof.
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionNodeConnection {
    pub token: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RotateExecutionNodeKeyCommand {
    pub expected_revision: u64,
    pub device_key_fingerprint: String,
    /// Hex-encoded replacement Ed25519 public key. The corresponding private
    /// key never leaves the Edge Node.
    pub device_public_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionNodeHeartbeatCommand {
    pub platform: Option<String>,
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub metadata: serde_json::Value,
    #[serde(default)]
    pub targets: Vec<ExecutionTargetRegistration>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClaimEdgeCommand {
    pub worker_id: String,
    pub lease_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HeartbeatEdgeCommand {
    pub expected_revision: u64,
    pub claim_token: String,
    pub lease_seconds: u64,
    pub side_effect_started: bool,
    pub progress: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FinishEdgeCommand {
    pub expected_revision: u64,
    pub claim_token: String,
    pub status: EdgeCommandStatus,
    pub output: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppendEdgeOutputCommand {
    pub claim_token: String,
    pub stream: EdgeOutputStream,
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionJobQuery {
    pub context_id: Option<String>,
    pub thread_id: Option<String>,
    pub target_id: Option<String>,
    pub status: Option<ExecutionJobStatus>,
    pub include_terminal: bool,
    pub newest_first: bool,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthorizeExecutionTargetCommand {
    pub target_id: String,
    pub scope: ExecutionTargetAuthorizationScope,
    pub scope_id: String,
}

#[derive(Debug, Clone)]
pub struct CreateObjectiveCommand {
    pub objective: NewObjective,
    pub harness: Option<ExactHarnessRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreateObjectiveResult {
    pub objective: ObjectiveRecord,
    pub harness_binding: Option<HarnessBinding>,
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

    /// Administrative Context projection shared by CLI, Dashboard and other
    /// trusted Runtime hosts. Principal-scoped products must authorize their
    /// Session before selecting it as the active Session.
    pub async fn context_overview(
        &self,
        context_id: &str,
        query: ContextOverviewQuery,
    ) -> SdkResult<ContextOverview> {
        self.runtime
            .context_overview(context_id, query)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn scheduler_snapshot(
        &self,
        context_id: &str,
        query: SchedulerQuery,
    ) -> SdkResult<SchedulerSnapshot> {
        self.runtime
            .scheduler_snapshot(context_id, query)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn model_usage(
        &self,
        context_id: &str,
        query: ModelUsageQuery,
    ) -> SdkResult<ModelUsagePage> {
        self.runtime
            .model_usage(context_id, query)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn attention_acknowledgements(
        &self,
        context_id: &str,
    ) -> SdkResult<Vec<AttentionAcknowledgement>> {
        self.runtime
            .attention_acknowledgements(context_id)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn acknowledge_attention(
        &self,
        context_id: &str,
        command: AcknowledgeAttentionCommand,
    ) -> SdkResult<AttentionAcknowledgement> {
        self.runtime
            .acknowledge_attention(context_id, command)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn thread_detail(
        &self,
        context_id: &str,
        thread_id: &str,
    ) -> SdkResult<ThreadDetail> {
        self.runtime
            .thread_detail(context_id, thread_id)
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| {
                SdkError::new(
                    SdkErrorCode::NotFound,
                    format!("Thread '{thread_id}' 在 Context '{context_id}' 中不存在"),
                )
            })
    }

    pub async fn query_ledger(&self, query: LedgerQuery) -> SdkResult<LedgerQueryPage> {
        self.runtime
            .query_ledger(query)
            .await
            .map_err(SdkError::internal)
    }

    pub fn runtime_status(&self) -> RuntimeStatus {
        self.runtime.runtime_status()
    }

    /// Explicit integrity audit. This intentionally remains a command rather
    /// than a hot-path status query because it replays the immutable Ledger.
    pub async fn audit_mind_projection(&self, context_id: &str) -> SdkResult<MindProjectionAudit> {
        self.runtime
            .audit_mind_projection(context_id)
            .await
            .map_err(SdkError::internal)
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

    /// Installs one validated, versioned Harness package through the shared
    /// application boundary used by CLI and future HTTP/embedded adapters.
    pub async fn install_harness_package(
        &self,
        package: HarnessPackage,
    ) -> SdkResult<HarnessDescriptor> {
        let descriptor = package.descriptor();
        self.runtime
            .register_harness_package(package)
            .await
            .map_err(|error| SdkError::new(SdkErrorCode::Conflict, error.to_string()))?;
        Ok(descriptor)
    }

    pub fn list_harnesses(&self) -> Vec<HarnessDescriptor> {
        self.runtime.harnesses()
    }

    pub fn get_harness(&self, id: &str, version: &str) -> SdkResult<HarnessDescriptor> {
        self.runtime
            .harnesses()
            .into_iter()
            .find(|candidate| candidate.id == id && candidate.version == version)
            .ok_or_else(|| {
                SdkError::new(
                    SdkErrorCode::NotFound,
                    format!("Harness '{id}@{version}' 未安装"),
                )
            })
    }

    /// Reads the immutable exact Harness binding that was actually selected
    /// for one Evaluation. This does not substitute an Objective default.
    pub async fn evaluation_harness_binding(
        &self,
        evaluation_id: &str,
    ) -> SdkResult<Option<HarnessBinding>> {
        self.runtime
            .evaluation_harness_binding(evaluation_id)
            .await
            .map_err(SdkError::internal)
    }

    /// Creates one Objective through the same principal-aware application
    /// boundary used by CLI and HTTP. When a Harness is requested, the
    /// Objective row and immutable exact-version binding commit atomically.
    pub async fn create_objective(
        &self,
        principal: &PrincipalAssertion,
        mut command: CreateObjectiveCommand,
    ) -> SdkResult<CreateObjectiveResult> {
        let coordinator = self
            .authorize_session(
                &principal.principal_id,
                &command.objective.coordinator_session_id,
            )
            .await?;
        let delivery = self
            .authorize_session(
                &principal.principal_id,
                &command.objective.delivery_session_id,
            )
            .await?;
        if coordinator.context_id != command.objective.context_id
            || delivery.context_id != command.objective.context_id
        {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Objective 的 coordinator/delivery Session 必须属于目标 Context",
            ));
        }
        if coordinator.agent_id != command.objective.agent_id
            || delivery.agent_id != command.objective.agent_id
        {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Objective 的 coordinator/delivery Session 必须属于目标 Agent",
            ));
        }
        command.objective.initiating_principal_id = Some(principal.principal_id.clone());
        match command.harness {
            Some(harness) => {
                let (objective, harness_binding) = self
                    .runtime
                    .create_objective_with_harness(command.objective, &harness.id, &harness.version)
                    .await
                    .map_err(|error| {
                        SdkError::new(SdkErrorCode::InvalidArgument, error.to_string())
                    })?;
                Ok(CreateObjectiveResult {
                    objective,
                    harness_binding: Some(harness_binding),
                })
            }
            None => self
                .runtime
                .create_objective(command.objective)
                .await
                .map(|objective| CreateObjectiveResult {
                    objective,
                    harness_binding: None,
                })
                .map_err(|error| SdkError::new(SdkErrorCode::Conflict, error.to_string())),
        }
    }

    pub async fn update_context(
        &self,
        context_id: &str,
        update: ContextUpdate,
    ) -> SdkResult<CognitiveContextRecord> {
        self.runtime
            .update_context(context_id, update)
            .await
            .map_err(|error| SdkError::new(SdkErrorCode::Conflict, error.to_string()))?
            .ok_or_else(|| {
                SdkError::new(
                    SdkErrorCode::NotFound,
                    format!("Context '{context_id}' 不存在"),
                )
            })
    }

    pub async fn list_execution_targets(
        &self,
        principal_id: &str,
    ) -> SdkResult<Vec<ExecutionTargetRecord>> {
        self.runtime
            .list_execution_targets(ExecutionTargetFilter {
                limit: Some(1_000),
                ..Default::default()
            })
            .await
            .map_err(SdkError::internal)
            .map(|targets| {
                targets
                    .into_iter()
                    .filter(|target| {
                        target.owner_principal_id.is_none()
                            || target.owner_principal_id.as_deref() == Some(principal_id)
                    })
                    .collect()
            })
    }

    pub async fn inspect_execution_target(
        &self,
        principal_id: &str,
        target_id: &str,
    ) -> SdkResult<ExecutionTargetRecord> {
        let target = self
            .runtime
            .get_execution_target(target_id)
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| {
                SdkError::new(
                    SdkErrorCode::NotFound,
                    format!("Execution Target '{target_id}' 不存在"),
                )
            })?;
        if target.owner_principal_id.is_some()
            && target.owner_principal_id.as_deref() != Some(principal_id)
        {
            return Err(SdkError::new(
                SdkErrorCode::Forbidden,
                format!("当前 Principal 不能访问 Execution Target '{target_id}'"),
            ));
        }
        Ok(target)
    }

    /// Registers a Target in the caller's authority domain. Public ingress
    /// adapters cannot create global Targets by omitting the owner.
    pub async fn register_execution_target(
        &self,
        principal_id: &str,
        mut registration: ExecutionTargetRegistration,
    ) -> SdkResult<ExecutionTargetRecord> {
        registration.owner_principal_id = Some(principal_id.to_string());
        self.runtime
            .register_execution_target(registration)
            .await
            .map_err(|error| SdkError::new(SdkErrorCode::Conflict, error.to_string()))
    }

    pub async fn set_execution_target_status(
        &self,
        principal_id: &str,
        target_id: &str,
        expected_revision: u64,
        status: ExecutionTargetStatus,
    ) -> SdkResult<ExecutionTargetRecord> {
        let current = self
            .inspect_execution_target(principal_id, target_id)
            .await?;
        if current.owner_principal_id.is_none() {
            return Err(SdkError::new(
                SdkErrorCode::Forbidden,
                "Runtime 全局 Target 不能通过 Principal-scoped SDK 修改",
            ));
        }
        match self
            .runtime
            .set_execution_target_status(target_id, expected_revision, status)
            .await
            .map_err(SdkError::internal)?
        {
            ExecutionTargetMutation::Updated(target) => Ok(target),
            ExecutionTargetMutation::Conflict { current } => Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!(
                    "Execution Target '{}' revision 冲突：当前为 {}",
                    current.id, current.revision
                ),
            )),
            ExecutionTargetMutation::NotFound => Err(SdkError::new(
                SdkErrorCode::NotFound,
                format!("Execution Target '{target_id}' 不存在"),
            )),
        }
    }

    pub async fn authorize_execution_target(
        &self,
        principal_id: &str,
        command: AuthorizeExecutionTargetCommand,
    ) -> SdkResult<ExecutionTargetAuthorizationRecord> {
        let target = self
            .inspect_execution_target(principal_id, &command.target_id)
            .await?;
        if target.owner_principal_id.as_deref() != Some(principal_id) {
            return Err(SdkError::new(
                SdkErrorCode::Forbidden,
                "Runtime 全局 Target 不能进入 Principal scoped authorization 模式",
            ));
        }
        if command.scope_id.trim().is_empty() {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Execution Target authorization scope_id 不能为空",
            ));
        }
        let identity = format!(
            "{}\u{0}{}\u{0}{}\u{0}{}",
            principal_id,
            command.target_id,
            command.scope.as_str(),
            command.scope_id
        );
        let digest = format!("{:x}", Sha256::digest(identity.as_bytes()));
        let authorization = NewExecutionTargetAuthorization {
            id: format!("target_auth_{}", &digest[..24]),
            target_id: command.target_id,
            owner_principal_id: principal_id.to_string(),
            scope: command.scope,
            scope_id: command.scope_id,
        };
        match self
            .runtime
            .authorize_execution_target(authorization)
            .await
            .map_err(SdkError::internal)?
        {
            ExecutionTargetAuthorizationMutation::Created(record)
            | ExecutionTargetAuthorizationMutation::Existing(record)
            | ExecutionTargetAuthorizationMutation::Updated(record) => Ok(record),
            ExecutionTargetAuthorizationMutation::Conflict { current } => Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!(
                    "Execution Target authorization '{}' revision 冲突：当前为 {}",
                    current.id, current.revision
                ),
            )),
            ExecutionTargetAuthorizationMutation::NotFound => Err(SdkError::new(
                SdkErrorCode::NotFound,
                "Execution Target authorization 不存在",
            )),
        }
    }

    pub async fn list_execution_target_authorizations(
        &self,
        principal_id: &str,
        target_id: Option<String>,
        active_only: bool,
    ) -> SdkResult<Vec<ExecutionTargetAuthorizationRecord>> {
        self.runtime
            .list_execution_target_authorizations(ExecutionTargetAuthorizationFilter {
                target_id,
                owner_principal_id: Some(principal_id.to_string()),
                active_only,
                limit: Some(1_000),
                ..Default::default()
            })
            .await
            .map_err(SdkError::internal)
    }

    pub async fn revoke_execution_target_authorization(
        &self,
        principal_id: &str,
        authorization_id: &str,
        expected_revision: u64,
        reason: &str,
    ) -> SdkResult<ExecutionTargetAuthorizationRecord> {
        let current = self
            .runtime
            .get_execution_target_authorization(authorization_id)
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| {
                SdkError::new(
                    SdkErrorCode::NotFound,
                    format!("Execution Target authorization '{authorization_id}' 不存在"),
                )
            })?;
        if current.owner_principal_id != principal_id {
            return Err(SdkError::new(
                SdkErrorCode::Forbidden,
                "当前 Principal 不能撤销这个 Execution Target authorization",
            ));
        }
        match self
            .runtime
            .revoke_execution_target_authorization(authorization_id, expected_revision, reason)
            .await
            .map_err(SdkError::internal)?
        {
            ExecutionTargetAuthorizationMutation::Updated(record)
            | ExecutionTargetAuthorizationMutation::Existing(record) => Ok(record),
            ExecutionTargetAuthorizationMutation::Conflict { current } => Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!(
                    "Execution Target authorization '{}' revision 冲突：当前为 {}",
                    current.id, current.revision
                ),
            )),
            ExecutionTargetAuthorizationMutation::NotFound => Err(SdkError::new(
                SdkErrorCode::NotFound,
                format!("Execution Target authorization '{authorization_id}' 不存在"),
            )),
            ExecutionTargetAuthorizationMutation::Created(_) => Err(SdkError::new(
                SdkErrorCode::Internal,
                "撤销 Execution Target authorization 时返回了无效的 created 状态",
            )),
        }
    }

    pub async fn list_capability_leases(
        &self,
        principal_id: &str,
        thread_id: Option<String>,
        target_id: Option<String>,
        active_only: bool,
    ) -> SdkResult<Vec<CapabilityLeaseRecord>> {
        if principal_id.trim().is_empty() {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Principal ID 不能为空",
            ));
        }
        self.runtime
            .list_capability_leases(CapabilityLeaseFilter {
                principal_id: Some(principal_id.to_string()),
                thread_id,
                target_id,
                active_at: active_only.then(chrono::Utc::now),
                limit: Some(1_000),
                ..Default::default()
            })
            .await
            .map_err(SdkError::internal)
    }

    pub async fn revoke_capability_lease(
        &self,
        principal_id: &str,
        lease_id: &str,
        expected_revision: u64,
        reason: &str,
    ) -> SdkResult<CapabilityLeaseRecord> {
        let current = self
            .runtime
            .list_capability_leases(CapabilityLeaseFilter {
                principal_id: Some(principal_id.to_string()),
                limit: Some(1_000),
                ..Default::default()
            })
            .await
            .map_err(SdkError::internal)?
            .into_iter()
            .find(|lease| lease.id == lease_id)
            .ok_or_else(|| {
                SdkError::new(
                    SdkErrorCode::NotFound,
                    format!("Capability Lease '{lease_id}' 不存在"),
                )
            })?;
        if current.revision != expected_revision {
            return Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!(
                    "Capability Lease '{lease_id}' revision 冲突：当前为 {}",
                    current.revision
                ),
            ));
        }
        match self
            .runtime
            .revoke_capability_lease(lease_id, expected_revision, reason)
            .await
            .map_err(SdkError::internal)?
        {
            CapabilityLeaseMutation::Updated(lease) | CapabilityLeaseMutation::Existing(lease) => {
                Ok(lease)
            }
            CapabilityLeaseMutation::Conflict { current } => Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!(
                    "Capability Lease '{}' revision 冲突：当前为 {}",
                    current.id, current.revision
                ),
            )),
            CapabilityLeaseMutation::NotFound => Err(SdkError::new(
                SdkErrorCode::NotFound,
                format!("Capability Lease '{lease_id}' 不存在"),
            )),
            CapabilityLeaseMutation::Created(_) => Err(SdkError::new(
                SdkErrorCode::Internal,
                "撤销 Capability Lease 时返回了无效的 created 状态",
            )),
        }
    }

    pub async fn create_node_pairing_code(
        &self,
        principal_id: &str,
        command: CreateNodePairingCodeCommand,
    ) -> SdkResult<NodePairingCode> {
        if principal_id.trim().is_empty() {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Principal ID 不能为空",
            ));
        }
        let ttl = command.expires_in_seconds.clamp(1, 900);
        let code = random_secret("pair", 20)?;
        let expires_at =
            chrono::Utc::now() + chrono::Duration::seconds(i64::try_from(ttl).unwrap_or(900));
        self.runtime
            .create_node_pairing_code(NewNodePairingCode {
                code_hash: hash_secret(&code),
                owner_principal_id: principal_id.to_string(),
                expires_at,
            })
            .await
            .map_err(SdkError::internal)?;
        Ok(NodePairingCode { code, expires_at })
    }

    pub async fn pair_execution_node(
        &self,
        command: PairExecutionNodeCommand,
    ) -> SdkResult<PairedExecutionNode> {
        if command.code.trim().is_empty()
            || command.name.trim().is_empty()
            || command.device_key_fingerprint.trim().is_empty()
            || command.device_public_key.trim().is_empty()
        {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "配对码、Node 名称、设备密钥指纹和公钥不能为空",
            ));
        }
        if command.protocol_version == 0 {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Edge protocol_version 必须大于 0",
            ));
        }
        let node_id = match command.node_id {
            Some(node_id) if !node_id.trim().is_empty() => node_id,
            _ => random_secret("node", 12)?,
        };
        let public_key = decode_hex(&command.device_public_key).map_err(|error| {
            SdkError::new(
                SdkErrorCode::InvalidArgument,
                format!("Edge device_public_key 无效: {error}"),
            )
        })?;
        let expected_fingerprint = format!("sha256:{:x}", Sha256::digest(&public_key));
        if command.device_key_fingerprint != expected_fingerprint {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Edge 设备公钥与指纹不一致",
            ));
        }
        let node = self
            .runtime
            .pair_execution_node(PairExecutionNode {
                code_hash: hash_secret(&command.code),
                node_id,
                name: command.name,
                device_key_fingerprint: command.device_key_fingerprint,
                device_public_key: command.device_public_key,
                protocol_version: command.protocol_version,
                platform: command.platform,
                capabilities: command.capabilities,
                metadata: command.metadata,
            })
            .await
            .map_err(|error| SdkError::new(SdkErrorCode::Unauthorized, error.to_string()))?;
        Ok(PairedExecutionNode { node })
    }

    pub async fn create_execution_node_identity_challenge(
        &self,
        node_id: &str,
    ) -> SdkResult<ExecutionNodeIdentityChallenge> {
        if node_id.trim().is_empty() {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Execution Node ID 不能为空",
            ));
        }
        let challenge_id = random_secret("challenge", 16)?;
        let nonce = random_secret("nonce", 32)?;
        let expires_at = chrono::Utc::now() + chrono::Duration::seconds(60);
        self.runtime
            .create_execution_node_challenge(NewExecutionNodeChallenge {
                id: challenge_id.clone(),
                node_id: node_id.to_string(),
                nonce_hash: hash_secret(&nonce),
                expires_at,
            })
            .await
            .map_err(|error| SdkError::new(SdkErrorCode::NotFound, error.to_string()))?;
        Ok(ExecutionNodeIdentityChallenge {
            challenge_id,
            nonce,
            expires_at,
        })
    }

    pub async fn connect_execution_node(
        &self,
        node_id: &str,
        command: ConnectExecutionNodeCommand,
    ) -> SdkResult<ExecutionNodeConnection> {
        if node_id.trim().is_empty()
            || command.challenge_id.trim().is_empty()
            || command.nonce.trim().is_empty()
            || command.signature.trim().is_empty()
        {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Execution Node connection proof 不完整",
            ));
        }
        let node = self
            .runtime
            .consume_execution_node_challenge(
                node_id,
                &command.challenge_id,
                &hash_secret(&command.nonce),
            )
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| {
                SdkError::new(
                    SdkErrorCode::Unauthorized,
                    "Execution Node challenge 无效、过期或已使用",
                )
            })?;
        let public_key = decode_hex(&node.device_public_key).map_err(|error| {
            SdkError::new(
                SdkErrorCode::Internal,
                format!("Execution Node 公钥存储损坏: {error}"),
            )
        })?;
        let signature = decode_hex(&command.signature).map_err(|error| {
            SdkError::new(
                SdkErrorCode::Unauthorized,
                format!("Execution Node signature 无效: {error}"),
            )
        })?;
        ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, public_key)
            .verify(
                &execution_node_connection_proof_message(
                    node_id,
                    &command.challenge_id,
                    &command.nonce,
                ),
                &signature,
            )
            .map_err(|_| {
                SdkError::new(
                    SdkErrorCode::Unauthorized,
                    "Execution Node 设备签名验证失败",
                )
            })?;
        let token = random_secret("edge_connection", 32)?;
        let expires_at = chrono::Utc::now() + chrono::Duration::minutes(15);
        self.runtime
            .issue_execution_node_connection_token(node_id, &hash_secret(&token), expires_at)
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| {
                SdkError::new(SdkErrorCode::Unauthorized, "Execution Node 已撤销或不存在")
            })?;
        Ok(ExecutionNodeConnection { token, expires_at })
    }

    pub async fn heartbeat_execution_node(
        &self,
        node_id: &str,
        device_token: &str,
        command: ExecutionNodeHeartbeatCommand,
    ) -> SdkResult<ExecutionNodeRecord> {
        let node = self.authenticate_node(node_id, device_token).await?;
        if command.targets.len() > self.runtime.config().edge_execution.max_targets_per_node {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                format!(
                    "单个 Node 一次最多发布 {} 个 Target",
                    self.runtime.config().edge_execution.max_targets_per_node
                ),
            ));
        }
        let updated = self
            .runtime
            .heartbeat_execution_node(
                node_id,
                command.platform,
                command.capabilities,
                command.metadata,
            )
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| SdkError::new(SdkErrorCode::NotFound, "Execution Node 不存在"))?;
        for mut target in command.targets {
            if !matches!(
                target.kind,
                ExecutionTargetKind::EdgeNode | ExecutionTargetKind::ManagedSsh
            ) {
                return Err(SdkError::new(
                    SdkErrorCode::InvalidArgument,
                    "Edge Node 只能发布 edge_node 或 managed_ssh Target",
                ));
            }
            target.owner_principal_id = Some(node.owner_principal_id.clone());
            target.provider_node_id = Some(node.id.clone());
            target.last_seen_at = Some(chrono::Utc::now());
            self.runtime
                .register_execution_target(target)
                .await
                .map_err(|error| SdkError::new(SdkErrorCode::Conflict, error.to_string()))?;
        }
        Ok(updated)
    }

    pub async fn list_execution_nodes(
        &self,
        principal_id: &str,
    ) -> SdkResult<Vec<ExecutionNodeRecord>> {
        self.runtime
            .list_execution_nodes(principal_id)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn revoke_execution_node(
        &self,
        principal_id: &str,
        node_id: &str,
        expected_revision: u64,
    ) -> SdkResult<ExecutionNodeRecord> {
        let current = self
            .runtime
            .list_execution_nodes(principal_id)
            .await
            .map_err(SdkError::internal)?
            .into_iter()
            .find(|node| node.id == node_id)
            .ok_or_else(|| SdkError::new(SdkErrorCode::NotFound, "Execution Node 不存在"))?;
        if current.revision != expected_revision {
            return Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!("Execution Node revision 冲突：当前为 {}", current.revision),
            ));
        }
        let updated = self
            .runtime
            .revoke_execution_node(node_id, principal_id, expected_revision)
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| SdkError::new(SdkErrorCode::NotFound, "Execution Node 不存在"))?;
        if updated.status != ExecutionNodeStatus::Revoked {
            return Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!(
                    "Execution Node revoke 未提交；当前 revision {}",
                    updated.revision
                ),
            ));
        }
        Ok(updated)
    }

    pub async fn rotate_execution_node_key(
        &self,
        node_id: &str,
        device_token: &str,
        command: RotateExecutionNodeKeyCommand,
    ) -> SdkResult<ExecutionNodeRecord> {
        let current = self.authenticate_node(node_id, device_token).await?;
        if current.revision != command.expected_revision {
            return Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!("Execution Node revision 冲突：当前为 {}", current.revision),
            ));
        }
        let public_key = decode_hex(&command.device_public_key).map_err(|error| {
            SdkError::new(
                SdkErrorCode::InvalidArgument,
                format!("Edge device_public_key 无效: {error}"),
            )
        })?;
        let expected_fingerprint = format!("sha256:{:x}", Sha256::digest(&public_key));
        if command.device_key_fingerprint != expected_fingerprint {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Edge 新设备公钥与指纹不一致",
            ));
        }
        match self
            .runtime
            .rotate_execution_node_key(
                node_id,
                command.expected_revision,
                &command.device_key_fingerprint,
                &command.device_public_key,
            )
            .await
            .map_err(SdkError::internal)?
        {
            ExecutionNodeMutation::Updated(node) => Ok(node),
            ExecutionNodeMutation::Conflict { current } => Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!("Execution Node revision 冲突：当前为 {}", current.revision),
            )),
            ExecutionNodeMutation::NotFound => Err(SdkError::new(
                SdkErrorCode::NotFound,
                "Execution Node 不存在",
            )),
        }
    }

    pub async fn claim_edge_command(
        &self,
        node_id: &str,
        device_token: &str,
        command: ClaimEdgeCommand,
    ) -> SdkResult<Option<EdgeCommandRecord>> {
        self.authenticate_node(node_id, device_token).await?;
        if command.worker_id.trim().is_empty() {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "worker_id 不能为空",
            ));
        }
        let lease_seconds = command.lease_seconds.clamp(5, 300);
        let claim_token = random_secret("claim", 24)?;
        self.runtime
            .claim_edge_command(
                node_id,
                &command.worker_id,
                &claim_token,
                chrono::Utc::now()
                    + chrono::Duration::seconds(i64::try_from(lease_seconds).unwrap_or(30)),
                self.runtime.config().edge_execution.max_in_flight_per_node,
            )
            .await
            .map_err(SdkError::internal)
    }

    pub async fn heartbeat_edge_command(
        &self,
        node_id: &str,
        device_token: &str,
        job_id: &str,
        command: HeartbeatEdgeCommand,
    ) -> SdkResult<EdgeCommandRecord> {
        self.authorize_node_command(node_id, device_token, job_id)
            .await?;
        let lease_seconds = command.lease_seconds.clamp(5, 300);
        match self
            .runtime
            .heartbeat_edge_command(
                job_id,
                command.expected_revision,
                &command.claim_token,
                chrono::Utc::now()
                    + chrono::Duration::seconds(i64::try_from(lease_seconds).unwrap_or(30)),
                command.side_effect_started,
                command.progress,
            )
            .await
            .map_err(SdkError::internal)?
        {
            EdgeCommandMutation::Updated(command) => Ok(command),
            EdgeCommandMutation::Conflict { current } => Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!(
                    "Edge Command revision/claim 冲突；当前为 {}",
                    current.revision
                ),
            )),
            EdgeCommandMutation::NotFound => {
                Err(SdkError::new(SdkErrorCode::NotFound, "Edge Command 不存在"))
            }
        }
    }

    pub async fn append_edge_command_output(
        &self,
        node_id: &str,
        device_token: &str,
        job_id: &str,
        command: AppendEdgeOutputCommand,
    ) -> SdkResult<EdgeCommandOutputChunk> {
        self.authorize_node_command(node_id, device_token, job_id)
            .await?;
        if command.text.is_empty() {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Edge output chunk 不能为空",
            ));
        }
        if command.text.len() > 64 * 1024 {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Edge output chunk 不能超过 64 KiB",
            ));
        }
        self.runtime
            .append_edge_command_output(job_id, &command.claim_token, command.stream, &command.text)
            .await
            .map_err(|error| SdkError::new(SdkErrorCode::Conflict, error.to_string()))
    }

    pub async fn list_edge_command_output(
        &self,
        job_id: &str,
        after_sequence: u64,
        limit: usize,
    ) -> SdkResult<Vec<EdgeCommandOutputChunk>> {
        self.runtime
            .list_edge_command_output(job_id, after_sequence, limit)
            .await
            .map_err(SdkError::internal)
    }

    pub async fn finish_edge_command(
        &self,
        node_id: &str,
        device_token: &str,
        job_id: &str,
        command: FinishEdgeCommand,
    ) -> SdkResult<EdgeCommandRecord> {
        self.authorize_node_command(node_id, device_token, job_id)
            .await?;
        if !matches!(
            command.status,
            EdgeCommandStatus::Succeeded | EdgeCommandStatus::Failed | EdgeCommandStatus::Cancelled
        ) {
            return Err(SdkError::new(
                SdkErrorCode::InvalidArgument,
                "Edge Node 只能提交 succeeded、failed 或 cancelled 终态",
            ));
        }
        match self
            .runtime
            .finish_edge_command(
                job_id,
                command.expected_revision,
                &command.claim_token,
                command.status,
                command.output,
                command.error,
            )
            .await
            .map_err(SdkError::internal)?
        {
            EdgeCommandMutation::Updated(command) => Ok(command),
            EdgeCommandMutation::Conflict { current } => Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!(
                    "Edge Command revision/claim 冲突；当前为 {}",
                    current.revision
                ),
            )),
            EdgeCommandMutation::NotFound => {
                Err(SdkError::new(SdkErrorCode::NotFound, "Edge Command 不存在"))
            }
        }
    }

    pub async fn list_execution_jobs(
        &self,
        principal_id: &str,
        query: ExecutionJobQuery,
    ) -> SdkResult<Vec<ExecutionJobRecord>> {
        let limit = query.limit.unwrap_or(200).clamp(1, 1_000);
        let mut jobs = self
            .runtime
            .list_execution_jobs(ExecutionJobFilter {
                context_id: query.context_id,
                thread_id: query.thread_id,
                target_id: query.target_id,
                status: query.status,
                include_terminal: query.include_terminal,
                newest_first: query.newest_first,
                // Principal is not a storage filter yet. Apply the limit only
                // after the authority filter so another Principal's rows can
                // never hide or expose the caller's Jobs.
                limit: None,
                ..Default::default()
            })
            .await
            .map_err(SdkError::internal)?;
        jobs.retain(|job| self.execution_job_visible_to_principal(job, principal_id));
        jobs.truncate(limit);
        Ok(jobs)
    }

    pub async fn inspect_execution_job(
        &self,
        principal_id: &str,
        job_id: &str,
    ) -> SdkResult<ExecutionJobRecord> {
        let job = self
            .runtime
            .get_execution_job(job_id)
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| SdkError::new(SdkErrorCode::NotFound, "Execution Job 不存在"))?;
        if !self.execution_job_visible_to_principal(&job, principal_id) {
            return Err(SdkError::new(
                SdkErrorCode::Forbidden,
                "当前 Principal 不能访问这个 Execution Job",
            ));
        }
        Ok(job)
    }

    pub async fn cancel_execution_job(
        &self,
        principal_id: &str,
        job_id: &str,
        expected_revision: u64,
        reason: Option<&str>,
    ) -> SdkResult<ExecutionJobRecord> {
        self.inspect_execution_job(principal_id, job_id).await?;
        match self
            .runtime
            .request_execution_job_cancel(job_id, expected_revision, reason)
            .await
            .map_err(SdkError::internal)?
        {
            JobReceipt::Applied { job, .. } | JobReceipt::Existing { job, .. } => Ok(job),
            JobReceipt::Conflict { current, .. } => Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!("Execution Job revision 冲突：当前为 {}", current.revision),
            )),
            JobReceipt::Rejected {
                current, reason, ..
            } => Err(SdkError::new(
                SdkErrorCode::Conflict,
                format!(
                    "Execution Job 当前为 {}，不能取消：{reason}",
                    current.status.as_str()
                ),
            )),
            JobReceipt::NotFound { .. } => Err(SdkError::new(
                SdkErrorCode::NotFound,
                "Execution Job 不存在",
            )),
        }
    }

    fn execution_job_visible_to_principal(
        &self,
        job: &ExecutionJobRecord,
        principal_id: &str,
    ) -> bool {
        job.initiating_principal_id.as_deref() == Some(principal_id)
            || (job.initiating_principal_id.is_none()
                && self.runtime.identity().principal_id == principal_id)
    }

    async fn authenticate_node(
        &self,
        node_id: &str,
        device_token: &str,
    ) -> SdkResult<ExecutionNodeRecord> {
        if node_id.trim().is_empty() || device_token.trim().is_empty() {
            return Err(SdkError::new(
                SdkErrorCode::Unauthorized,
                "Execution Node 凭证缺失",
            ));
        }
        let node = self
            .runtime
            .authenticate_execution_node(node_id, &hash_secret(device_token))
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| SdkError::new(SdkErrorCode::Unauthorized, "Execution Node 凭证无效"))?;
        if node.status == ExecutionNodeStatus::Revoked {
            return Err(SdkError::new(
                SdkErrorCode::Forbidden,
                "Execution Node 已被撤销",
            ));
        }
        Ok(node)
    }

    async fn authorize_node_command(
        &self,
        node_id: &str,
        device_token: &str,
        job_id: &str,
    ) -> SdkResult<EdgeCommandRecord> {
        self.authenticate_node(node_id, device_token).await?;
        let command = self
            .runtime
            .get_edge_command(job_id)
            .await
            .map_err(SdkError::internal)?
            .ok_or_else(|| SdkError::new(SdkErrorCode::NotFound, "Edge Command 不存在"))?;
        if command.provider_node_id != node_id {
            return Err(SdkError::new(
                SdkErrorCode::Forbidden,
                "Execution Node 不能访问其他 Node 的命令",
            ));
        }
        Ok(command)
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
            .send_as_principal_with_harness(
                command.text,
                command.actor,
                principal.principal_id.clone(),
                command.client_message_id,
                command.harness,
            )
            .await
            .map_err(|error| SdkError::new(SdkErrorCode::InvalidArgument, error.to_string()))
    }

    pub async fn retry_dialogue_turn(
        &self,
        principal: &PrincipalAssertion,
        command: RetryDialogueTurnCommand,
    ) -> SdkResult<DialogueTurnRetryReceipt> {
        self.authorize_session(&principal.principal_id, &command.session_id)
            .await?;
        self.runtime
            .session(command.session_id)
            .retry_dialogue_turn_as_principal(
                command.root_turn_id,
                principal.principal_id.clone(),
                command.expected_thread_revision,
                command.expected_result_event_id,
                command.retry_request_id,
            )
            .await
            .map_err(|error| SdkError::new(SdkErrorCode::Conflict, error.to_string()))
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

fn hash_secret(secret: &str) -> String {
    format!("{:x}", Sha256::digest(secret.as_bytes()))
}

/// Canonical bytes signed by an Edge Node when exchanging a one-shot
/// challenge for a short-lived connection credential.
pub fn execution_node_connection_proof_message(
    node_id: &str,
    challenge_id: &str,
    nonce: &str,
) -> Vec<u8> {
    format!("morphz-edge-connect-v1\0{node_id}\0{challenge_id}\0{nonce}").into_bytes()
}

fn decode_hex(value: &str) -> Result<Vec<u8>, &'static str> {
    if !value.len().is_multiple_of(2) {
        return Err("hex 长度必须为偶数");
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = hex_nibble(pair[0]).ok_or("包含非十六进制字符")?;
            let low = hex_nibble(pair[1]).ok_or("包含非十六进制字符")?;
            Ok((high << 4) | low)
        })
        .collect()
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn random_secret(prefix: &str, byte_count: usize) -> SdkResult<String> {
    let mut bytes = vec![0_u8; byte_count];
    getrandom::fill(&mut bytes).map_err(|error| {
        SdkError::new(
            SdkErrorCode::Internal,
            format!("操作系统随机数生成失败: {error}"),
        )
    })?;
    let mut encoded = String::with_capacity(prefix.len() + 1 + byte_count * 2);
    encoded.push_str(prefix);
    encoded.push('_');
    use std::fmt::Write as _;
    for byte in bytes {
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(encoded)
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
