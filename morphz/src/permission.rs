use crate::approval::{
    ApprovalAction, ApprovalDecision, ApprovalProvider, ApprovalRequest, CapabilityDelta,
};
use crate::memory::ApprovalStatus;
use crate::sandbox::SandboxPathPattern;
use glob::{MatchOptions, Pattern};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub type PermissionError = Box<dyn std::error::Error + Send + Sync>;

tokio::task_local! {
    /// One exact durable grant consumed atomically with the current physical
    /// ExecutionJob claim. It is a task-local capability, never a reusable
    /// profile mutation.
    pub static CURRENT_DURABLE_APPROVAL: Option<DurableApprovalGrant>;

}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalRequirement {
    pub action: ApprovalAction,
    pub requested: CapabilityDelta,
    pub justification: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableApprovalGrant {
    pub approval_id: String,
    pub grant_id: String,
    pub policy_digest: String,
    pub action: ApprovalAction,
    pub requested: CapabilityDelta,
}

impl DurableApprovalGrant {
    fn covers(
        &self,
        action: &ApprovalAction,
        requested: &CapabilityDelta,
        policy_digest: &str,
    ) -> bool {
        if self.policy_digest != policy_digest {
            return false;
        }
        let action_matches = match (&self.action, action) {
            (
                ApprovalAction::Shell {
                    command: granted_command,
                    cwd: granted_cwd,
                },
                ApprovalAction::Shell { command, cwd },
            ) => granted_command == command && granted_cwd == cwd,
            (
                ApprovalAction::ToolOperation {
                    tool: granted_tool,
                    operation: granted_operation,
                    target: granted_target,
                },
                ApprovalAction::ToolOperation {
                    tool,
                    operation,
                    target,
                },
            ) => {
                granted_tool == tool
                    && granted_operation == operation
                    && (granted_target.is_none() || granted_target == target)
            }
            _ => false,
        };
        action_matches
            && (!requested.network || self.requested.network)
            && requested
                .read_roots
                .iter()
                .all(|root| self.requested.read_roots.contains(root))
            && requested
                .write_roots
                .iter()
                .all(|root| self.requested.write_roots.contains(root))
            && requested
                .secret_env
                .iter()
                .all(|name| self.requested.secret_env.contains(name))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    RequestApproval,
    AutoReview,
    FullAccess,
    Custom,
}

impl PermissionMode {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "request_approval" | "request-approval" | "human" => Ok(Self::RequestApproval),
            "auto_review" | "auto-review" | "auto_approval" | "auto-approval" => {
                Ok(Self::AutoReview)
            }
            "full_access" | "full-access" | "full" => Ok(Self::FullAccess),
            "custom" => Ok(Self::Custom),
            other => Err(format!("unsupported permission mode '{other}'")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::RequestApproval => "request_approval",
            Self::AutoReview => "auto_review",
            Self::FullAccess => "full_access",
            Self::Custom => "custom",
        }
    }

    pub fn preset(self) -> Option<(SandboxMode, ApprovalPolicy, ReviewerKind)> {
        match self {
            Self::RequestApproval => Some((
                SandboxMode::WorkspaceWrite,
                ApprovalPolicy::OnRequest,
                ReviewerKind::User,
            )),
            Self::AutoReview => Some((
                SandboxMode::WorkspaceWrite,
                ApprovalPolicy::OnRequest,
                ReviewerKind::AutoReview,
            )),
            Self::FullAccess => Some((
                SandboxMode::DangerFullAccess,
                ApprovalPolicy::Never,
                ReviewerKind::Deny,
            )),
            Self::Custom => None,
        }
    }

    pub fn from_effective_controls(
        sandbox_mode: SandboxMode,
        approval_policy: ApprovalPolicy,
        reviewer: ReviewerKind,
    ) -> Self {
        if sandbox_mode == SandboxMode::DangerFullAccess {
            return Self::FullAccess;
        }
        match (approval_policy, reviewer) {
            (ApprovalPolicy::OnRequest, ReviewerKind::AutoReview) => Self::AutoReview,
            (ApprovalPolicy::OnRequest, ReviewerKind::User) => Self::RequestApproval,
            _ => Self::Custom,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxMode {
    WorkspaceWrite,
    DangerFullAccess,
}

impl SandboxMode {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "workspace-write" | "workspace_write" | "workspace" => Ok(Self::WorkspaceWrite),
            "danger-full-access" | "danger_full_access" | "full-access" | "full_access"
            | "full" => Ok(Self::DangerFullAccess),
            other => Err(format!("unsupported Sandbox mode '{other}'")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::WorkspaceWrite => "workspace-write",
            Self::DangerFullAccess => "danger-full-access",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalPolicy {
    OnRequest,
    Never,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewerKind {
    User,
    AutoReview,
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShellEnvironmentPolicy {
    RemoveSensitive,
    InheritAll,
}

/// User-configurable permission input. Non-custom modes override sandbox, approval, and reviewer
/// with the selected preset while path and environment policies remain configurable.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PermissionConfig {
    pub mode: PermissionMode,
    pub workspace_root: String,
    /// Keep the host filesystem readable while restricting writes to the
    /// primary Workspace and explicit writable roots. Protected paths remain
    /// inaccessible even when this compatibility-oriented default is enabled.
    pub read_only_outside_workspace: bool,
    pub read_roots: Vec<String>,
    pub write_roots: Vec<String>,
    pub protected_paths: Vec<String>,
    pub network: bool,
    pub sandbox_mode: SandboxMode,
    pub approval_policy: ApprovalPolicy,
    pub reviewer: ReviewerKind,
    /// Optional Model Route used only by the automatic permission reviewer.
    /// When absent, the reviewer reuses the main inference model for backward
    /// compatibility.
    pub auto_review_model: Option<String>,
    pub shell_environment_policy: ShellEnvironmentPolicy,
}

impl Default for PermissionConfig {
    fn default() -> Self {
        Self {
            mode: PermissionMode::AutoReview,
            workspace_root: ".".to_string(),
            read_only_outside_workspace: true,
            read_roots: Vec::new(),
            write_roots: Vec::new(),
            protected_paths: vec![
                "**/.env".to_string(),
                "**/.env.*".to_string(),
                "**/.git".to_string(),
                "**/.git/**".to_string(),
                "**/.ssh".to_string(),
                "**/.ssh/**".to_string(),
                ".morphz/config.toml".to_string(),
                ".morphz/morphz.toml".to_string(),
            ],
            network: true,
            sandbox_mode: SandboxMode::WorkspaceWrite,
            approval_policy: ApprovalPolicy::OnRequest,
            reviewer: ReviewerKind::AutoReview,
            auto_review_model: None,
            shell_environment_policy: ShellEnvironmentPolicy::RemoveSensitive,
        }
    }
}

impl PermissionConfig {
    pub fn preset(&self) -> (SandboxMode, ApprovalPolicy, ReviewerKind) {
        self.mode
            .preset()
            .unwrap_or((self.sandbox_mode, self.approval_policy, self.reviewer))
    }

    pub fn effective_mode(&self) -> PermissionMode {
        let (sandbox_mode, approval_policy, reviewer) = self.preset();
        PermissionMode::from_effective_controls(sandbox_mode, approval_policy, reviewer)
    }
}

#[derive(Debug, Clone)]
pub struct PermissionProfile {
    pub mode: PermissionMode,
    pub sandbox_mode: SandboxMode,
    pub approval_policy: ApprovalPolicy,
    pub reviewer: ReviewerKind,
    pub auto_review_model: Option<String>,
    pub workspace_root: PathBuf,
    pub read_roots: Vec<PathBuf>,
    pub write_roots: Vec<PathBuf>,
    pub protected_paths: Vec<String>,
    /// Operator-configured network policy for the restricted workspace
    /// sandbox. `network` is the effective value and is necessarily true in
    /// full-access mode, so it cannot be used to reconstruct this intent when
    /// a live Session switches back to a restricted preset.
    configured_network: bool,
    pub network: bool,
    pub shell_environment_policy: ShellEnvironmentPolicy,
}

impl PermissionProfile {
    pub fn from_config(config: &PermissionConfig) -> Result<Self, PermissionError> {
        let auto_review_model = config
            .auto_review_model
            .as_deref()
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .map(ToOwned::to_owned);
        if config.auto_review_model.is_some() && auto_review_model.is_none() {
            return Err("permissions.auto_review_model must not be empty".into());
        }
        let workspace_root = canonicalize_existing(Path::new(&config.workspace_root), "workspace")?;
        if !workspace_root.is_dir() {
            return Err(format!(
                "permission configuration workspace_root '{}' is not a directory",
                workspace_root.display()
            )
            .into());
        }
        let (sandbox_mode, approval_policy, reviewer) = config.preset();
        let mut read_roots = vec![workspace_root.clone()];
        let mut write_roots = vec![workspace_root.clone()];
        if config.read_only_outside_workspace {
            push_unique(&mut read_roots, filesystem_root(&workspace_root));
        }
        for root in &config.read_roots {
            push_unique(
                &mut read_roots,
                canonicalize_existing(Path::new(root), "read root")?,
            );
        }
        for root in &config.write_roots {
            let root = canonicalize_existing(Path::new(root), "write root")?;
            push_unique(&mut read_roots, root.clone());
            push_unique(&mut write_roots, root);
        }
        for pattern in &config.protected_paths {
            Pattern::new(pattern)
                .map_err(|error| format!("invalid protected_paths glob '{pattern}': {error}"))?;
        }
        Ok(Self {
            mode: config.mode,
            sandbox_mode,
            approval_policy,
            reviewer,
            auto_review_model,
            workspace_root,
            read_roots,
            write_roots,
            protected_paths: config.protected_paths.clone(),
            configured_network: config.network,
            network: sandbox_mode == SandboxMode::DangerFullAccess || config.network,
            shell_environment_policy: config.shell_environment_policy,
        })
    }

    pub fn full_access(&self) -> bool {
        self.sandbox_mode == SandboxMode::DangerFullAccess
    }

    pub fn effective_mode(&self) -> PermissionMode {
        PermissionMode::from_effective_controls(
            self.sandbox_mode,
            self.approval_policy,
            self.reviewer,
        )
    }

    pub fn permission_request_available(&self) -> bool {
        self.sandbox_mode == SandboxMode::WorkspaceWrite
            && self.approval_policy == ApprovalPolicy::OnRequest
    }

    pub fn resolve_candidate(&self, input: &str) -> Result<ResolvedPath, PermissionError> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return Err("path must not be empty".into());
        }
        let raw = Path::new(trimmed);
        let candidate = if raw.is_absolute() {
            raw.to_path_buf()
        } else {
            self.workspace_root.join(raw)
        };
        let resolved_anchor = resolve_existing_or_parent(&candidate)?;
        let protected = !self.full_access()
            && self
                .protected_paths
                .iter()
                .any(|pattern| path_matches_pattern(&candidate, &resolved_anchor, pattern));
        Ok(ResolvedPath {
            candidate,
            resolved_anchor,
            protected,
        })
    }

    pub fn inspect_path(
        &self,
        input: &str,
        access: FilesystemAccess,
    ) -> Result<PathDecision, PermissionError> {
        let resolved = self.resolve_candidate(input)?;
        if self.full_access() {
            return Ok(PathDecision::Allowed(resolved.candidate));
        }
        if resolved.protected {
            return Ok(PathDecision::Denied(format!(
                "path '{}' matches a non-overridable protected_paths rule",
                resolved.candidate.display()
            )));
        }
        let roots = match access {
            FilesystemAccess::Read => &self.read_roots,
            FilesystemAccess::Write => &self.write_roots,
        };
        if roots
            .iter()
            .any(|root| resolved.resolved_anchor.starts_with(root))
        {
            Ok(PathDecision::Allowed(resolved.candidate))
        } else {
            Ok(PathDecision::NeedsApproval {
                candidate: resolved.candidate,
                resolved_anchor: resolved.resolved_anchor,
            })
        }
    }

    pub fn canonical_permission_root(&self, input: &str) -> Result<PathBuf, PermissionError> {
        let resolved = self.resolve_candidate(input)?;
        if resolved.protected {
            return Err(format!(
                "additional permissions cannot override protected_paths: {}",
                resolved.candidate.display()
            )
            .into());
        }
        let canonical = std::fs::canonicalize(&resolved.candidate).map_err(|error| {
            format!(
                "additional permission path must already exist and be resolvable '{}': {error}",
                resolved.candidate.display()
            )
        })?;
        Ok(canonical)
    }

    pub fn path_allowed(&self, path: &Path, access: FilesystemAccess) -> bool {
        self.inspect_path(&path.to_string_lossy(), access)
            .is_ok_and(|decision| matches!(decision, PathDecision::Allowed(_)))
    }

    /// Keep protected paths symbolic. Native sandbox backends compile these
    /// rules directly; Runtime startup must never enumerate a workspace merely
    /// to discover every current match. Newly-created protected paths are
    /// therefore covered by the same policy without rebuilding the Profile.
    pub fn sandbox_protected_patterns(&self, roots: &[PathBuf]) -> Vec<SandboxPathPattern> {
        let mut rules = Vec::new();
        for pattern in &self.protected_paths {
            let path = Path::new(pattern);
            if path.is_absolute() {
                let root = path.ancestors().last().unwrap_or(path);
                let relative = path.strip_prefix(root).unwrap_or(path);
                push_unique_sandbox_pattern(
                    &mut rules,
                    SandboxPathPattern::new(root, slash_path(relative)),
                );
                continue;
            }
            for root in roots {
                push_unique_sandbox_pattern(
                    &mut rules,
                    SandboxPathPattern::new(root, slash_path(path)),
                );
            }
        }
        rules
    }
}

fn filesystem_root(path: &Path) -> PathBuf {
    path.ancestors()
        .last()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| path.to_path_buf())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilesystemAccess {
    Read,
    Write,
}

impl FilesystemAccess {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedPath {
    pub candidate: PathBuf,
    pub resolved_anchor: PathBuf,
    pub protected: bool,
}

#[derive(Debug, Clone)]
pub enum PathDecision {
    Allowed(PathBuf),
    NeedsApproval {
        candidate: PathBuf,
        resolved_anchor: PathBuf,
    },
    Denied(String),
}

#[derive(Debug, Clone, Default)]
pub struct ApprovalContext {
    pub context_id: String,
    pub session_id: String,
    pub attempt_id: String,
    pub thread_id: String,
    pub root_turn_id: String,
    pub trigger_event_id: String,
    pub trigger_sequence: u64,
}

pub struct PermissionBroker {
    profile: Arc<PermissionProfile>,
    automatic_approval: Arc<dyn ApprovalProvider>,
    human_approval: Arc<dyn ApprovalProvider>,
    auto_review_model: std::sync::RwLock<Option<String>>,
    /// Durable Session policy projected into the live authorization boundary.
    /// The startup Profile remains the fallback for Sessions without an
    /// override and for work that is not causally attached to a Session.
    session_sandbox_modes: std::sync::RwLock<HashMap<String, SandboxMode>>,
    session_permission_modes: std::sync::RwLock<HashMap<String, PermissionMode>>,
}

impl PermissionBroker {
    pub fn new(profile: Arc<PermissionProfile>, approval: Arc<dyn ApprovalProvider>) -> Self {
        Self::new_with_reviewers(profile, Arc::clone(&approval), approval)
    }

    pub fn new_with_reviewers(
        profile: Arc<PermissionProfile>,
        automatic_approval: Arc<dyn ApprovalProvider>,
        human_approval: Arc<dyn ApprovalProvider>,
    ) -> Self {
        let auto_review_model = std::sync::RwLock::new(profile.auto_review_model.clone());
        Self {
            profile,
            automatic_approval,
            human_approval,
            auto_review_model,
            session_sandbox_modes: std::sync::RwLock::new(HashMap::new()),
            session_permission_modes: std::sync::RwLock::new(HashMap::new()),
        }
    }

    pub fn set_session_permission_mode(&self, session_id: &str, mode: Option<PermissionMode>) {
        let mut modes = self
            .session_permission_modes
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match mode {
            Some(mode) => {
                modes.insert(session_id.to_string(), mode);
            }
            None => {
                modes.remove(session_id);
            }
        }
    }

    pub fn session_permission_mode(&self, session_id: &str) -> Option<PermissionMode> {
        self.session_permission_modes
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(session_id)
            .copied()
    }

    pub fn set_session_sandbox_mode(&self, session_id: &str, mode: Option<SandboxMode>) {
        let mut modes = self
            .session_sandbox_modes
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match mode {
            Some(mode) => {
                modes.insert(session_id.to_string(), mode);
            }
            None => {
                modes.remove(session_id);
            }
        }
    }

    pub fn session_sandbox_mode(&self, session_id: &str) -> Option<SandboxMode> {
        self.session_sandbox_modes
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(session_id)
            .copied()
    }

    pub fn profile(&self) -> Arc<PermissionProfile> {
        let requested = crate::tool::CURRENT_SESSION_ID
            .try_with(|session_id| {
                (
                    self.session_permission_mode(session_id),
                    self.session_sandbox_mode(session_id),
                )
            })
            .unwrap_or((None, None));
        self.profile_with_overrides(requested.0, requested.1)
    }

    pub fn startup_profile(&self) -> Arc<PermissionProfile> {
        Arc::clone(&self.profile)
    }

    pub fn profile_for_session(&self, session_id: &str) -> Arc<PermissionProfile> {
        self.profile_with_overrides(
            self.session_permission_mode(session_id),
            self.session_sandbox_mode(session_id),
        )
    }

    fn profile_with_overrides(
        &self,
        permission_mode: Option<PermissionMode>,
        sandbox_mode: Option<SandboxMode>,
    ) -> Arc<PermissionProfile> {
        if let Some(mode) = permission_mode {
            let Some((sandbox_mode, approval_policy, reviewer)) = mode.preset() else {
                return Arc::clone(&self.profile);
            };
            if mode == self.profile.mode && sandbox_mode == self.profile.sandbox_mode {
                return Arc::clone(&self.profile);
            }
            let mut profile = self.profile.as_ref().clone();
            profile.mode = mode;
            profile.sandbox_mode = sandbox_mode;
            profile.approval_policy = approval_policy;
            profile.reviewer = reviewer;
            profile.network = match sandbox_mode {
                SandboxMode::DangerFullAccess => true,
                SandboxMode::WorkspaceWrite => self.profile.configured_network,
            };
            return Arc::new(profile);
        }

        let requested = sandbox_mode;
        let Some(requested) = requested.filter(|mode| *mode != self.profile.sandbox_mode) else {
            return Arc::clone(&self.profile);
        };
        let mut profile = self.profile.as_ref().clone();
        profile.mode = PermissionMode::Custom;
        profile.sandbox_mode = requested;
        // Full access necessarily permits network. Returning to a Workspace
        // sandbox restores the operator's original restricted-mode choice;
        // the effective full-access value deliberately does not erase it.
        profile.network = match requested {
            SandboxMode::DangerFullAccess => true,
            SandboxMode::WorkspaceWrite => self.profile.configured_network,
        };
        Arc::new(profile)
    }

    pub fn policy_digest(&self) -> String {
        let profile = self.profile();
        let auto_review_model = self
            .auto_review_model
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let material = serde_json::json!({
            "mode": profile.mode,
            "sandbox_mode": profile.sandbox_mode,
            "approval_policy": profile.approval_policy,
            "reviewer": profile.reviewer,
            "auto_review_model": auto_review_model,
            "workspace_root": profile.workspace_root,
            "read_roots": profile.read_roots,
            "write_roots": profile.write_roots,
            "protected_paths": profile.protected_paths,
            "network": profile.network,
            "shell_environment_policy": profile.shell_environment_policy,
        });
        let bytes = serde_json::to_vec(&material).unwrap_or_default();
        format!("policy_{:x}", Sha256::digest(bytes))
    }

    pub fn auto_review_model(&self) -> Option<String> {
        self.auto_review_model
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn set_auto_review_model(&self, model: Option<String>) {
        *self
            .auto_review_model
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = model;
    }

    pub fn pending_approval_status(&self) -> ApprovalStatus {
        match self.profile().reviewer {
            ReviewerKind::User => ApprovalStatus::PendingHuman,
            ReviewerKind::AutoReview | ReviewerKind::Deny => ApprovalStatus::PendingAuto,
        }
    }

    pub async fn review(
        &self,
        request: &ApprovalRequest,
    ) -> Result<ApprovalDecision, PermissionError> {
        match self.profile().reviewer {
            ReviewerKind::User => self.review_human(request).await,
            ReviewerKind::AutoReview => match self.review_automatic(request).await {
                Ok(ApprovalDecision::AskHuman { .. }) => self.review_human(request).await,
                Ok(decision) => Ok(decision),
                Err(error) => {
                    tracing::warn!(
                        approval_id = %request.approval_id,
                        %error,
                        event_code = "permission.auto_review.fallback_to_human",
                        "Automatic permission review could not complete; requesting human review"
                    );
                    self.review_human(request).await
                }
            },
            ReviewerKind::Deny => Ok(ApprovalDecision::Deny {
                rationale: "the current permission Profile forbids capability expansion"
                    .to_string(),
                risk_tags: vec!["permission_profile_deny".to_string()],
            }),
        }
    }

    pub async fn review_automatic(
        &self,
        request: &ApprovalRequest,
    ) -> Result<ApprovalDecision, PermissionError> {
        self.automatic_approval.review(request).await
    }

    pub async fn review_human(
        &self,
        request: &ApprovalRequest,
    ) -> Result<ApprovalDecision, PermissionError> {
        self.human_approval.review(request).await
    }

    pub fn approval_requirement_for_path(
        &self,
        input: &str,
        access: FilesystemAccess,
        tool: &str,
        operation: &str,
    ) -> Result<(PathBuf, Option<ApprovalRequirement>), PermissionError> {
        let profile = self.profile();
        match profile.inspect_path(input, access)? {
            PathDecision::Allowed(path) => Ok((path, None)),
            PathDecision::Denied(reason) => Err(reason.into()),
            PathDecision::NeedsApproval {
                candidate,
                resolved_anchor,
            } => {
                if profile.approval_policy == ApprovalPolicy::Never {
                    return Err(
                        "the current permission Profile does not allow out-of-bound capabilities"
                            .into(),
                    );
                }
                let requested = match access {
                    FilesystemAccess::Read => CapabilityDelta {
                        read_roots: vec![resolved_anchor],
                        ..CapabilityDelta::default()
                    },
                    FilesystemAccess::Write => CapabilityDelta {
                        write_roots: vec![resolved_anchor],
                        ..CapabilityDelta::default()
                    },
                };
                Ok((
                    candidate.clone(),
                    Some(ApprovalRequirement {
                        action: ApprovalAction::ToolOperation {
                            tool: tool.to_string(),
                            operation: operation.to_string(),
                            target: Some(candidate.clone()),
                        },
                        requested,
                        justification: format!(
                            "tool {tool} requires {} access to '{}'",
                            access.as_str(),
                            candidate.display(),
                        ),
                    }),
                ))
            }
        }
    }

    pub fn approval_requirement_for_delta(
        &self,
        action: ApprovalAction,
        requested: CapabilityDelta,
        justification: String,
    ) -> Result<Option<ApprovalRequirement>, PermissionError> {
        let profile = self.profile();
        if requested.is_empty() || profile.full_access() {
            return Ok(None);
        }
        if profile.approval_policy == ApprovalPolicy::Never {
            return Err(
                "the current permission Profile does not allow out-of-bound capabilities".into(),
            );
        }
        Ok(Some(ApprovalRequirement {
            action,
            requested,
            justification,
        }))
    }

    pub async fn authorize_path(
        &self,
        input: &str,
        access: FilesystemAccess,
        tool: &str,
        operation: &str,
        context: ApprovalContext,
    ) -> Result<PathBuf, PermissionError> {
        let (candidate, requirement) =
            self.approval_requirement_for_path(input, access, tool, operation)?;
        match requirement {
            None => Ok(candidate),
            Some(requirement) => {
                self.authorize_delta(
                    requirement.action,
                    requirement.requested,
                    requirement.justification,
                    context,
                )
                .await?;
                Ok(candidate)
            }
        }
    }

    pub async fn authorize_delta(
        &self,
        action: ApprovalAction,
        requested: CapabilityDelta,
        justification: String,
        context: ApprovalContext,
    ) -> Result<(), PermissionError> {
        let profile = self.profile();
        if requested.is_empty() || profile.full_access() {
            return Ok(());
        }
        if profile.approval_policy == ApprovalPolicy::Never {
            return Err(
                "the current permission Profile does not allow out-of-bound capabilities".into(),
            );
        }
        let policy_digest = self.policy_digest();
        if CURRENT_DURABLE_APPROVAL
            .try_with(|grant| {
                grant
                    .as_ref()
                    .is_some_and(|grant| grant.covers(&action, &requested, &policy_digest))
            })
            .unwrap_or(false)
        {
            return Ok(());
        }
        let approval_id = format!(
            "approval_{}_{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
            std::process::id()
        );
        let decision = self
            .review(&ApprovalRequest {
                approval_id,
                context_id: nonempty(context.context_id, "default-context"),
                session_id: nonempty(context.session_id, "default-session"),
                attempt_id: nonempty(context.attempt_id, "unknown-attempt"),
                thread_id: nonempty(context.thread_id, "unknown-thread"),
                root_turn_id: nonempty(context.root_turn_id, "unknown-root-turn"),
                trigger_event_id: nonempty(context.trigger_event_id, "unknown-trigger"),
                trigger_sequence: context.trigger_sequence,
                model_alias: None,
                action,
                requested,
                justification,
                lease_offer: None,
            })
            .await?;
        match decision {
            ApprovalDecision::AllowOnce { rationale, .. } => {
                tracing::info!(event_code = "permission.review.allow_once", %rationale, "Permission reviewer allowed a one-time capability expansion");
                Ok(())
            }
            ApprovalDecision::AllowLease { .. } => {
                Err("the current direct permission request has no Capability Lease offer; the reviewer cannot approve a lease".into())
            }
            ApprovalDecision::Deny { rationale, .. } => {
                Err(format!("permission review rejected this operation: {rationale}").into())
            }
            ApprovalDecision::AskHuman { rationale, .. } => {
                Err(format!("the reviewer requested human confirmation, but the current approval chain has no available human channel: {rationale}").into())
            }
        }
    }
}

fn nonempty(value: String, fallback: &str) -> String {
    if value.trim().is_empty() {
        fallback.to_string()
    } else {
        value
    }
}

fn canonicalize_existing(path: &Path, kind: &str) -> Result<PathBuf, PermissionError> {
    std::fs::canonicalize(path).map_err(|error| {
        format!(
            "failed to resolve permission configuration {kind} '{}': {error}",
            path.display()
        )
        .into()
    })
}

fn resolve_existing_or_parent(path: &Path) -> Result<PathBuf, PermissionError> {
    if path.exists() {
        return std::fs::canonicalize(path).map_err(|error| {
            format!("failed to resolve path '{}': {error}", path.display()).into()
        });
    }
    let mut current = path.parent().unwrap_or_else(|| Path::new("."));
    loop {
        if current.exists() {
            return std::fs::canonicalize(current).map_err(|error| {
                format!(
                    "failed to resolve path ancestor '{}': {error}",
                    current.display()
                )
                .into()
            });
        }
        current = current.parent().ok_or_else(|| {
            format!(
                "path '{}' has no resolvable ancestor directory",
                path.display()
            )
        })?;
    }
}

fn path_matches_pattern(candidate: &Path, resolved: &Path, pattern: &str) -> bool {
    let Ok(pattern) = Pattern::new(pattern) else {
        return true;
    };
    let options = MatchOptions {
        case_sensitive: true,
        require_literal_separator: true,
        require_literal_leading_dot: false,
    };
    [candidate, resolved].into_iter().any(|path| {
        let normalized = path.to_string_lossy().replace('\\', "/");
        let without_root = normalized.trim_start_matches('/');
        pattern.matches_with(&normalized, options)
            || pattern.matches_with(without_root, options)
            || path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| pattern.matches_with(name, options))
    })
}

fn slash_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn push_unique_sandbox_pattern(
    patterns: &mut Vec<SandboxPathPattern>,
    pattern: SandboxPathPattern,
) {
    if !patterns.iter().any(|existing| existing == &pattern) {
        patterns.push(pattern);
    }
}

fn push_unique(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::DenyAllApprovalProvider;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::TempDir;

    struct CountingApprovalProvider {
        calls: Arc<AtomicUsize>,
        rationale: &'static str,
    }

    #[async_trait::async_trait]
    impl ApprovalProvider for CountingApprovalProvider {
        async fn review(
            &self,
            _request: &ApprovalRequest,
        ) -> Result<ApprovalDecision, Box<dyn std::error::Error + Send + Sync>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(ApprovalDecision::AllowOnce {
                rationale: self.rationale.to_string(),
                risk_tags: vec!["test".to_string()],
            })
        }
    }

    fn profile(root: &Path) -> PermissionProfile {
        let config = PermissionConfig {
            workspace_root: root.to_string_lossy().into_owned(),
            read_roots: Vec::new(),
            write_roots: Vec::new(),
            ..PermissionConfig::default()
        };
        PermissionProfile::from_config(&config).unwrap()
    }

    #[test]
    fn canonical_containment_replaces_absolute_and_parent_syntax_rules() {
        let root = TempDir::new().unwrap();
        std::fs::create_dir(root.path().join("sub")).unwrap();
        std::fs::write(root.path().join("inside.txt"), "ok").unwrap();
        let profile = profile(root.path());

        assert!(matches!(
            profile
                .inspect_path(
                    root.path().join("inside.txt").to_str().unwrap(),
                    FilesystemAccess::Read
                )
                .unwrap(),
            PathDecision::Allowed(_)
        ));
        assert!(matches!(
            profile
                .inspect_path("sub/../inside.txt", FilesystemAccess::Read)
                .unwrap(),
            PathDecision::Allowed(_)
        ));
    }

    #[test]
    fn exact_missing_protected_path_is_retained_symbolically_for_native_sandbox() {
        let root = TempDir::new().unwrap();
        let mut config = PermissionConfig {
            workspace_root: root.path().to_string_lossy().into_owned(),
            read_roots: Vec::new(),
            write_roots: Vec::new(),
            ..PermissionConfig::default()
        };
        config
            .protected_paths
            .push("future-config.toml".to_string());
        let profile = PermissionProfile::from_config(&config).unwrap();
        assert!(profile
            .sandbox_protected_patterns(&profile.read_roots)
            .contains(&SandboxPathPattern::new(
                &profile.workspace_root,
                "future-config.toml",
            )));
    }

    #[test]
    fn outside_paths_are_read_only_and_protected_paths_cannot_escalate() {
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let profile = profile(root.path());
        assert!(matches!(
            profile
                .inspect_path(outside.path().to_str().unwrap(), FilesystemAccess::Read)
                .unwrap(),
            PathDecision::Allowed(_)
        ));
        assert!(matches!(
            profile
                .inspect_path(outside.path().to_str().unwrap(), FilesystemAccess::Write)
                .unwrap(),
            PathDecision::NeedsApproval { .. }
        ));
        std::fs::write(root.path().join(".env"), "TOKEN=x").unwrap();
        assert!(matches!(
            profile
                .inspect_path(".env", FilesystemAccess::Read)
                .unwrap(),
            PathDecision::Denied(_)
        ));
        let outside_secret = outside.path().join(".env");
        std::fs::write(&outside_secret, "TOKEN=y").unwrap();
        assert!(matches!(
            profile
                .inspect_path(outside_secret.to_str().unwrap(), FilesystemAccess::Read)
                .unwrap(),
            PathDecision::Denied(_)
        ));
    }

    #[test]
    fn additional_workspace_roots_are_readable_and_writable() {
        let root = TempDir::new().unwrap();
        let additional = TempDir::new().unwrap();
        let config = PermissionConfig {
            workspace_root: root.path().to_string_lossy().into_owned(),
            write_roots: vec![additional.path().to_string_lossy().into_owned()],
            ..PermissionConfig::default()
        };
        let profile = PermissionProfile::from_config(&config).unwrap();

        for access in [FilesystemAccess::Read, FilesystemAccess::Write] {
            assert!(matches!(
                profile
                    .inspect_path(additional.path().to_str().unwrap(), access)
                    .unwrap(),
                PathDecision::Allowed(_)
            ));
        }
    }

    #[test]
    fn default_permission_boundary_keeps_network_available() {
        let root = TempDir::new().unwrap();
        assert!(profile(root.path()).network);
    }

    #[test]
    fn product_modes_resolve_to_orthogonal_runtime_controls() {
        let config = PermissionConfig {
            mode: PermissionMode::RequestApproval,
            ..PermissionConfig::default()
        };
        assert_eq!(
            config.preset(),
            (
                SandboxMode::WorkspaceWrite,
                ApprovalPolicy::OnRequest,
                ReviewerKind::User,
            )
        );
        assert_eq!(
            PermissionConfig::default().preset().2,
            ReviewerKind::AutoReview
        );
        let config = PermissionConfig {
            mode: PermissionMode::FullAccess,
            ..PermissionConfig::default()
        };
        assert_eq!(
            config.preset(),
            (
                SandboxMode::DangerFullAccess,
                ApprovalPolicy::Never,
                ReviewerKind::Deny,
            )
        );

        let legacy_cli_full_access = PermissionConfig {
            mode: PermissionMode::Custom,
            sandbox_mode: SandboxMode::DangerFullAccess,
            ..PermissionConfig::default()
        };
        assert_eq!(
            legacy_cli_full_access.effective_mode(),
            PermissionMode::FullAccess,
            "the permission selector must describe an effective legacy full-access CLI override honestly",
        );
    }

    #[test]
    fn automatic_reviewer_model_route_is_optional_but_never_ambiguous() {
        let root = TempDir::new().unwrap();
        let configured = PermissionConfig {
            workspace_root: root.path().to_string_lossy().into_owned(),
            auto_review_model: Some("  reviewer-luna  ".to_string()),
            ..PermissionConfig::default()
        };
        assert_eq!(
            PermissionProfile::from_config(&configured)
                .unwrap()
                .auto_review_model
                .as_deref(),
            Some("reviewer-luna")
        );

        let invalid = PermissionConfig {
            workspace_root: root.path().to_string_lossy().into_owned(),
            auto_review_model: Some("   ".to_string()),
            ..PermissionConfig::default()
        };
        assert!(PermissionProfile::from_config(&invalid).is_err());
    }

    #[test]
    fn changing_the_automatic_reviewer_route_invalidates_permission_policy_digest() {
        let root = TempDir::new().unwrap();
        let profile = Arc::new(
            PermissionProfile::from_config(&PermissionConfig {
                workspace_root: root.path().to_string_lossy().into_owned(),
                ..PermissionConfig::default()
            })
            .unwrap(),
        );
        let broker = PermissionBroker::new(
            profile,
            Arc::new(DenyAllApprovalProvider::new("test reviewer")),
        );
        let before = broker.policy_digest();
        broker.set_auto_review_model(Some("reviewer-luna".to_string()));
        let after = broker.policy_digest();

        assert_ne!(before, after);
        assert_eq!(broker.auto_review_model().as_deref(), Some("reviewer-luna"));
    }

    #[test]
    fn protected_paths_remain_symbolic_for_os_sandbox() {
        let root = TempDir::new().unwrap();
        let profile = profile(root.path());
        let protected = profile.sandbox_protected_patterns(&profile.read_roots);
        assert!(protected
            .iter()
            .any(|rule| rule.root == profile.workspace_root && rule.glob == "**/.git/**"));
        assert!(protected
            .iter()
            .any(|rule| rule.root == profile.workspace_root && rule.glob == "**/.env"));
    }

    #[tokio::test]
    async fn full_access_never_calls_approval_provider() {
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let config = PermissionConfig {
            mode: PermissionMode::FullAccess,
            workspace_root: root.path().to_string_lossy().into_owned(),
            read_roots: Vec::new(),
            write_roots: Vec::new(),
            ..PermissionConfig::default()
        };
        let broker = PermissionBroker::new(
            Arc::new(PermissionProfile::from_config(&config).unwrap()),
            Arc::new(DenyAllApprovalProvider::new("must not be called")),
        );
        let allowed = broker
            .authorize_path(
                outside.path().to_str().unwrap(),
                FilesystemAccess::Read,
                "read",
                "read",
                ApprovalContext::default(),
            )
            .await
            .unwrap();
        assert_eq!(allowed, outside.path());
    }

    #[tokio::test]
    async fn session_sandbox_change_is_immediate_and_isolated() {
        let root = TempDir::new().unwrap();
        let broker = Arc::new(PermissionBroker::new(
            Arc::new(profile(root.path())),
            Arc::new(DenyAllApprovalProvider::new("test reviewer")),
        ));

        crate::tool::CURRENT_SESSION_ID
            .scope("session-a".to_string(), {
                let broker = Arc::clone(&broker);
                async move {
                    assert_eq!(broker.profile().sandbox_mode, SandboxMode::WorkspaceWrite);
                    broker
                        .set_session_sandbox_mode("session-a", Some(SandboxMode::DangerFullAccess));
                    // The second check represents a later tool preflight in
                    // the same live Evaluation: no new Turn is required.
                    assert!(broker.profile().full_access());
                }
            })
            .await;

        crate::tool::CURRENT_SESSION_ID
            .scope("session-b".to_string(), async {
                assert_eq!(broker.profile().sandbox_mode, SandboxMode::WorkspaceWrite);
            })
            .await;
        assert_eq!(broker.profile().sandbox_mode, SandboxMode::WorkspaceWrite);
    }

    #[tokio::test]
    async fn session_permission_presets_switch_complete_policy_and_reviewer_immediately() {
        let root = TempDir::new().unwrap();
        let automatic_calls = Arc::new(AtomicUsize::new(0));
        let human_calls = Arc::new(AtomicUsize::new(0));
        let config = PermissionConfig {
            mode: PermissionMode::FullAccess,
            workspace_root: root.path().to_string_lossy().into_owned(),
            network: false,
            ..PermissionConfig::default()
        };
        let broker = Arc::new(PermissionBroker::new_with_reviewers(
            Arc::new(PermissionProfile::from_config(&config).unwrap()),
            Arc::new(CountingApprovalProvider {
                calls: Arc::clone(&automatic_calls),
                rationale: "automatic",
            }),
            Arc::new(CountingApprovalProvider {
                calls: Arc::clone(&human_calls),
                rationale: "human",
            }),
        ));

        crate::tool::CURRENT_SESSION_ID
            .scope("session-a".to_string(), {
                let broker = Arc::clone(&broker);
                async move {
                    broker
                        .set_session_permission_mode("session-a", Some(PermissionMode::AutoReview));
                    let automatic = broker.profile();
                    assert_eq!(automatic.mode, PermissionMode::AutoReview);
                    assert_eq!(automatic.sandbox_mode, SandboxMode::WorkspaceWrite);
                    assert_eq!(automatic.approval_policy, ApprovalPolicy::OnRequest);
                    assert_eq!(automatic.reviewer, ReviewerKind::AutoReview);
                    assert!(!automatic.network);
                    broker
                        .authorize_delta(
                            ApprovalAction::ToolOperation {
                                tool: "exec".to_string(),
                                operation: "network".to_string(),
                                target: None,
                            },
                            CapabilityDelta {
                                network: true,
                                ..CapabilityDelta::default()
                            },
                            "automatic approval test".to_string(),
                            ApprovalContext::default(),
                        )
                        .await
                        .unwrap();

                    broker.set_session_permission_mode(
                        "session-a",
                        Some(PermissionMode::RequestApproval),
                    );
                    assert_eq!(broker.profile().reviewer, ReviewerKind::User);
                    broker
                        .authorize_delta(
                            ApprovalAction::ToolOperation {
                                tool: "exec".to_string(),
                                operation: "network".to_string(),
                                target: None,
                            },
                            CapabilityDelta {
                                network: true,
                                ..CapabilityDelta::default()
                            },
                            "human approval test".to_string(),
                            ApprovalContext::default(),
                        )
                        .await
                        .unwrap();

                    broker
                        .set_session_permission_mode("session-a", Some(PermissionMode::FullAccess));
                    let full = broker.profile();
                    assert!(full.full_access());
                    assert_eq!(full.approval_policy, ApprovalPolicy::Never);
                }
            })
            .await;

        assert_eq!(automatic_calls.load(Ordering::SeqCst), 1);
        assert_eq!(human_calls.load(Ordering::SeqCst), 1);
        crate::tool::CURRENT_SESSION_ID
            .scope("session-b".to_string(), async {
                assert!(broker.profile().full_access());
            })
            .await;
    }

    #[test]
    fn restricted_session_presets_restore_network_enabled_before_full_access_startup() {
        let root = TempDir::new().unwrap();
        let config = PermissionConfig {
            mode: PermissionMode::FullAccess,
            workspace_root: root.path().to_string_lossy().into_owned(),
            network: true,
            ..PermissionConfig::default()
        };
        let broker = PermissionBroker::new(
            Arc::new(PermissionProfile::from_config(&config).unwrap()),
            Arc::new(DenyAllApprovalProvider::new("must not be called")),
        );

        for mode in [PermissionMode::AutoReview, PermissionMode::RequestApproval] {
            broker.set_session_permission_mode("session-network", Some(mode));
            let profile = broker.profile_for_session("session-network");
            assert_eq!(profile.sandbox_mode, SandboxMode::WorkspaceWrite);
            assert!(
                profile.network,
                "{mode:?} must retain the configured network baseline"
            );
        }
    }
}
