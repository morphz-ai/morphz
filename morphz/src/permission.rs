use crate::approval::{
    ApprovalAction, ApprovalDecision, ApprovalProvider, ApprovalRequest, CapabilityDelta,
};
use crate::memory::ApprovalStatus;
use glob::{MatchOptions, Pattern};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxMode {
    WorkspaceWrite,
    DangerFullAccess,
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

/// 用户可配置的权限输入。非 custom 模式会使用对应预设覆盖
/// sandbox/approval/reviewer 三项，路径和环境策略仍可配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PermissionConfig {
    pub mode: PermissionMode,
    pub workspace_root: String,
    pub read_roots: Vec<String>,
    pub write_roots: Vec<String>,
    pub protected_paths: Vec<String>,
    pub network: bool,
    pub sandbox_mode: SandboxMode,
    pub approval_policy: ApprovalPolicy,
    pub reviewer: ReviewerKind,
    pub shell_environment_policy: ShellEnvironmentPolicy,
}

impl Default for PermissionConfig {
    fn default() -> Self {
        Self {
            mode: PermissionMode::AutoReview,
            workspace_root: ".".to_string(),
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
            ],
            network: false,
            sandbox_mode: SandboxMode::WorkspaceWrite,
            approval_policy: ApprovalPolicy::OnRequest,
            reviewer: ReviewerKind::AutoReview,
            shell_environment_policy: ShellEnvironmentPolicy::RemoveSensitive,
        }
    }
}

impl PermissionConfig {
    pub fn preset(&self) -> (SandboxMode, ApprovalPolicy, ReviewerKind) {
        match self.mode {
            PermissionMode::RequestApproval => (
                SandboxMode::WorkspaceWrite,
                ApprovalPolicy::OnRequest,
                ReviewerKind::User,
            ),
            PermissionMode::AutoReview => (
                SandboxMode::WorkspaceWrite,
                ApprovalPolicy::OnRequest,
                ReviewerKind::AutoReview,
            ),
            PermissionMode::FullAccess => (
                SandboxMode::DangerFullAccess,
                ApprovalPolicy::Never,
                ReviewerKind::Deny,
            ),
            PermissionMode::Custom => (self.sandbox_mode, self.approval_policy, self.reviewer),
        }
    }
}

#[derive(Debug, Clone)]
pub struct PermissionProfile {
    pub mode: PermissionMode,
    pub sandbox_mode: SandboxMode,
    pub approval_policy: ApprovalPolicy,
    pub reviewer: ReviewerKind,
    pub workspace_root: PathBuf,
    pub read_roots: Vec<PathBuf>,
    pub write_roots: Vec<PathBuf>,
    pub protected_paths: Vec<String>,
    protected_existing_paths: Vec<PathBuf>,
    pub network: bool,
    pub shell_environment_policy: ShellEnvironmentPolicy,
}

impl PermissionProfile {
    pub fn from_config(config: &PermissionConfig) -> Result<Self, PermissionError> {
        let workspace_root = canonicalize_existing(Path::new(&config.workspace_root), "workspace")?;
        if !workspace_root.is_dir() {
            return Err(format!(
                "权限配置 workspace_root '{}' 不是目录",
                workspace_root.display()
            )
            .into());
        }
        let (sandbox_mode, approval_policy, reviewer) = config.preset();
        let mut read_roots = vec![workspace_root.clone()];
        let mut write_roots = vec![workspace_root.clone()];
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
                .map_err(|error| format!("无效 protected_paths glob '{pattern}': {error}"))?;
        }
        let protected_existing_paths = expand_protected_paths(&read_roots, &config.protected_paths);
        Ok(Self {
            mode: config.mode,
            sandbox_mode,
            approval_policy,
            reviewer,
            workspace_root,
            read_roots,
            write_roots,
            protected_paths: config.protected_paths.clone(),
            protected_existing_paths,
            network: sandbox_mode == SandboxMode::DangerFullAccess || config.network,
            shell_environment_policy: config.shell_environment_policy,
        })
    }

    pub fn full_access(&self) -> bool {
        self.sandbox_mode == SandboxMode::DangerFullAccess
    }

    pub fn resolve_candidate(&self, input: &str) -> Result<ResolvedPath, PermissionError> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return Err("路径不能为空".into());
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
                "路径 '{}' 命中不可覆盖的 protected_paths 规则",
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
                "额外权限不能覆盖 protected_paths：{}",
                resolved.candidate.display()
            )
            .into());
        }
        let canonical = std::fs::canonicalize(&resolved.candidate).map_err(|error| {
            format!(
                "额外权限路径必须已存在且可解析 '{}': {error}",
                resolved.candidate.display()
            )
        })?;
        if !canonical.is_dir() {
            return Err(format!("额外权限路径 '{}' 不是目录", canonical.display()).into());
        }
        Ok(canonical)
    }

    pub fn path_allowed(&self, path: &Path, access: FilesystemAccess) -> bool {
        self.inspect_path(&path.to_string_lossy(), access)
            .is_ok_and(|decision| matches!(decision, PathDecision::Allowed(_)))
    }

    /// 将通用 protected_paths glob 展开为当前授权根中已经存在的物理路径，
    /// 供原生 OS 沙箱编译精确 deny 规则。直接文件工具仍会在每次访问时匹配
    /// 原始 glob，因此尚不存在的目标也不能绕过 Runtime 权限代理。
    pub fn existing_protected_paths(&self, roots: &[PathBuf]) -> Vec<PathBuf> {
        let mut matches = self.protected_existing_paths.clone();
        let additional_roots = roots
            .iter()
            .filter(|root| {
                !self
                    .read_roots
                    .iter()
                    .any(|base| root.starts_with(base) || base.starts_with(*root))
            })
            .cloned()
            .collect::<Vec<_>>();
        for path in expand_protected_paths(&additional_roots, &self.protected_paths) {
            push_unique(&mut matches, path);
        }
        matches
    }
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
}

pub struct PermissionBroker {
    profile: Arc<PermissionProfile>,
    approval: Arc<dyn ApprovalProvider>,
}

impl PermissionBroker {
    pub fn new(profile: Arc<PermissionProfile>, approval: Arc<dyn ApprovalProvider>) -> Self {
        Self { profile, approval }
    }

    pub fn profile(&self) -> &Arc<PermissionProfile> {
        &self.profile
    }

    pub fn policy_digest(&self) -> String {
        let material = serde_json::json!({
            "mode": self.profile.mode,
            "sandbox_mode": self.profile.sandbox_mode,
            "approval_policy": self.profile.approval_policy,
            "reviewer": self.profile.reviewer,
            "workspace_root": self.profile.workspace_root,
            "read_roots": self.profile.read_roots,
            "write_roots": self.profile.write_roots,
            "protected_paths": self.profile.protected_paths,
            "network": self.profile.network,
            "shell_environment_policy": self.profile.shell_environment_policy,
        });
        let bytes = serde_json::to_vec(&material).unwrap_or_default();
        format!("policy_{:x}", Sha256::digest(bytes))
    }

    pub fn pending_approval_status(&self) -> ApprovalStatus {
        match self.profile.reviewer {
            ReviewerKind::User => ApprovalStatus::PendingHuman,
            ReviewerKind::AutoReview | ReviewerKind::Deny => ApprovalStatus::PendingAuto,
        }
    }

    pub async fn review(
        &self,
        request: &ApprovalRequest,
    ) -> Result<ApprovalDecision, PermissionError> {
        self.approval.review(request).await
    }

    pub fn approval_requirement_for_path(
        &self,
        input: &str,
        access: FilesystemAccess,
        tool: &str,
        operation: &str,
    ) -> Result<(PathBuf, Option<ApprovalRequirement>), PermissionError> {
        match self.profile.inspect_path(input, access)? {
            PathDecision::Allowed(path) => Ok((path, None)),
            PathDecision::Denied(reason) => Err(reason.into()),
            PathDecision::NeedsApproval {
                candidate,
                resolved_anchor,
            } => {
                if self.profile.approval_policy == ApprovalPolicy::Never {
                    return Err("当前权限 Profile 不允许请求边界外能力".into());
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
                            "工具 {tool} 需要对 '{}' 执行 {} 操作",
                            candidate.display(),
                            access.as_str()
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
        if requested.is_empty() || self.profile.full_access() {
            return Ok(None);
        }
        if self.profile.approval_policy == ApprovalPolicy::Never {
            return Err("当前权限 Profile 不允许请求边界外能力".into());
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
        if requested.is_empty() || self.profile.full_access() {
            return Ok(());
        }
        if self.profile.approval_policy == ApprovalPolicy::Never {
            return Err("当前权限 Profile 不允许请求边界外能力".into());
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
            .approval
            .review(&ApprovalRequest {
                approval_id,
                context_id: nonempty(context.context_id, "default-context"),
                session_id: nonempty(context.session_id, "default-session"),
                attempt_id: nonempty(context.attempt_id, "unknown-attempt"),
                action,
                requested,
                justification,
            })
            .await?;
        match decision {
            ApprovalDecision::AllowOnce { rationale, .. } => {
                tracing::info!(%rationale, "权限代理允许一次性能力扩张");
                Ok(())
            }
            ApprovalDecision::Deny { rationale, .. } => {
                Err(format!("权限审批拒绝本次操作: {rationale}").into())
            }
            ApprovalDecision::AskHuman { rationale, .. } => {
                Err(format!("审批者要求人工确认，但当前审批链没有可用人工通道: {rationale}").into())
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
    std::fs::canonicalize(path)
        .map_err(|error| format!("无法解析权限配置 {kind} '{}': {error}", path.display()).into())
}

fn resolve_existing_or_parent(path: &Path) -> Result<PathBuf, PermissionError> {
    if path.exists() {
        return std::fs::canonicalize(path)
            .map_err(|error| format!("无法解析路径 '{}': {error}", path.display()).into());
    }
    let mut current = path.parent().unwrap_or_else(|| Path::new("."));
    loop {
        if current.exists() {
            return std::fs::canonicalize(current).map_err(|error| {
                format!("无法解析路径祖先 '{}': {error}", current.display()).into()
            });
        }
        current = current
            .parent()
            .ok_or_else(|| format!("路径 '{}' 没有可解析的祖先目录", path.display()))?;
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

fn expand_protected_paths(roots: &[PathBuf], patterns: &[String]) -> Vec<PathBuf> {
    let mut matches = Vec::new();
    for root in roots {
        let escaped_root = Pattern::escape(&root.to_string_lossy().replace('\\', "/"));
        for pattern in patterns {
            if !pattern
                .chars()
                .any(|character| matches!(character, '*' | '?' | '['))
            {
                let candidate = if Path::new(pattern).is_absolute() {
                    PathBuf::from(pattern)
                } else {
                    root.join(pattern)
                };
                let stable = std::fs::canonicalize(&candidate).unwrap_or(candidate);
                push_unique(&mut matches, stable);
                continue;
            }
            let expression = if Path::new(pattern).is_absolute() {
                pattern.clone()
            } else {
                format!("{escaped_root}/{}", pattern.trim_start_matches('/'))
            };
            let Ok(entries) = glob::glob(&expression) else {
                continue;
            };
            for entry in entries.flatten() {
                if let Ok(canonical) = std::fs::canonicalize(entry) {
                    push_unique(&mut matches, canonical);
                }
            }
        }
    }
    matches
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
    use tempfile::TempDir;

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
    fn exact_missing_protected_path_is_retained_for_native_sandbox() {
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
            .existing_protected_paths(&profile.read_roots)
            .contains(&profile.workspace_root.join("future-config.toml")));
    }

    #[test]
    fn outside_paths_need_approval_and_protected_paths_cannot_escalate() {
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let profile = profile(root.path());
        assert!(matches!(
            profile
                .inspect_path(outside.path().to_str().unwrap(), FilesystemAccess::Read)
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
    }

    #[test]
    fn existing_protected_paths_are_precomputed_for_os_sandbox() {
        let root = TempDir::new().unwrap();
        std::fs::create_dir(root.path().join(".git")).unwrap();
        let profile = profile(root.path());
        let protected = profile.existing_protected_paths(&profile.read_roots);
        assert!(protected
            .iter()
            .any(|path| path.ends_with(Path::new(".git"))));
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
}
