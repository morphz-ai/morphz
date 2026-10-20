//! Runtime-owned byte handoff to domain Hosts. A Host never interprets a
//! Runtime path against its own filesystem or manufactures a picker grant.
use super::*;
use crate::execution_target::{route_snapshot_from_job, ExecutionRouteSnapshot};
use crate::memory::{ExecutionTargetKind, ExecutionTargetRecord, ExecutionTargetStatus};
use crate::permission::PermissionProfile;
#[cfg(unix)]
use crate::permission::{FilesystemAccess, PathDecision};
use base64::Engine;
#[cfg(unix)]
use std::io::Read;
use std::path::{Component, Path};

#[cfg(unix)]
const MAX_BYTES: u64 = 32 * 1024 * 1024;

fn active_invocation(job: &ExecutionJobRecord, principal: &str, call: &str) -> bool {
    job.initiating_principal_id.as_deref() == Some(principal)
        && job.tool_call_id == call
        && job.status == ExecutionJobStatus::Running
        && job.cancel_requested_at.is_none()
        && job
            .lease_expires_at
            .is_some_and(|expiry| expiry > chrono::Utc::now())
}

fn current_local_workspace(
    route: &ExecutionRouteSnapshot,
    target: &ExecutionTargetRecord,
    profile: &PermissionProfile,
) -> bool {
    route.target_id == target.id
        && route.backend_kind == ExecutionTargetKind::InProcessLocal
        && route.provider_node_id.is_none()
        && route.endpoint_ref.is_none()
        && target.kind == route.backend_kind
        && target.status == ExecutionTargetStatus::Online
        && target.revision == route.target_revision
        && target.policy_digest == route.policy_digest
        && target.workspace_root.as_deref() == profile.workspace_root.to_str()
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionWorkspaceRead {
    pub tool_call_id: String,
    pub path: String,
    pub sha256: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct ExecutionWorkspaceFile {
    pub name: String,
    pub sha256: String,
    pub size_bytes: usize,
    pub data_base64: String,
    pub target_id: String,
}

fn relative_path(path: &str) -> Result<&Path, String> {
    let parsed = Path::new(path);
    if path.is_empty()
        || path.len() > 4096
        || path.contains(['\0', '\\'])
        || parsed
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        || parsed.is_absolute()
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("Workspace source requires a normalized relative file path".into());
    }
    Ok(parsed)
}

#[cfg(unix)]
fn read_file(profile: &PermissionProfile, path: &str) -> Result<(String, Vec<u8>), String> {
    use nix::fcntl::{open, openat, OFlag};
    use nix::sys::stat::Mode;
    use std::os::unix::fs::MetadataExt;
    let relative = relative_path(path)?;
    let candidate = profile.workspace_root.join(relative);
    if !matches!(
        profile
            .inspect_path(&candidate.to_string_lossy(), FilesystemAccess::Read)
            .map_err(|e| e.to_string())?,
        PathDecision::Allowed(_)
    ) {
        return Err("Workspace file is not readable under the current permission profile".into());
    }
    // Walk handles, not string prefixes: a concurrent directory symlink swap
    // cannot redirect the read outside the already-authorized workspace.
    let mut directory = open(
        &profile.workspace_root,
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .map_err(|e| e.to_string())?;
    let parts: Vec<_> = relative.components().collect();
    for part in &parts[..parts.len() - 1] {
        directory = openat(
            &directory,
            Path::new(part.as_os_str()),
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|e| e.to_string())?;
    }
    let name = parts.last().expect("non-empty path").as_os_str();
    let fd = openat(
        &directory,
        Path::new(name),
        OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .map_err(|e| e.to_string())?;
    let mut file = std::fs::File::from(fd);
    let before = file.metadata().map_err(|e| e.to_string())?;
    if !before.is_file() || before.len() > MAX_BYTES {
        return Err("Workspace import accepts regular files up to 32 MiB".into());
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    Read::by_ref(&mut file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let after = file.metadata().map_err(|e| e.to_string())?;
    if bytes.len() as u64 != before.len()
        || before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
    {
        return Err("Workspace source changed during read".into());
    }
    Ok((name.to_string_lossy().into_owned(), bytes))
}

#[cfg(not(unix))]
fn read_file(_profile: &PermissionProfile, _path: &str) -> Result<(String, Vec<u8>), String> {
    Err("This execution backend does not yet provide handle-confined workspace byte reads; use an accepted attachment or directory grant".into())
}

impl MorphzRuntime {
    pub async fn read_execution_workspace_file(
        &self,
        principal: &str,
        job_id: &str,
        request: ExecutionWorkspaceRead,
    ) -> Result<ExecutionWorkspaceFile, String> {
        relative_path(&request.path)?;
        let job = self
            .workspace_read_authority(principal, job_id, &request.tool_call_id)
            .await?;
        let profile = self.inner.permissions.profile_for_session(&job.session_id);
        let policy = Arc::clone(&profile);
        let path = request.path.clone();
        let (name, bytes) = tokio::task::spawn_blocking(move || read_file(&profile, &path))
            .await
            .map_err(|e| e.to_string())??;
        self.workspace_read_authority(principal, job_id, &request.tool_call_id)
            .await?;
        if self
            .inner
            .permissions
            .profile_for_session(&job.session_id)
            .as_ref()
            != policy.as_ref()
        {
            return Err("Workspace permission profile changed during read".into());
        }
        use sha2::Digest;
        let sha256 = format!("{:x}", sha2::Sha256::digest(&bytes));
        if request
            .sha256
            .as_ref()
            .is_some_and(|expected| expected != &sha256)
        {
            return Err("Workspace source version changed; import not committed".into());
        }
        Ok(ExecutionWorkspaceFile {
            name,
            sha256,
            size_bytes: bytes.len(),
            data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            target_id: job.target_id,
        })
    }

    async fn workspace_read_authority(
        &self,
        principal: &str,
        job_id: &str,
        call: &str,
    ) -> Result<ExecutionJobRecord, String> {
        let job = self
            .inner
            .store
            .get_execution_job(job_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Execution Job not found")?;
        if !active_invocation(&job, principal, call) {
            return Err("Workspace read requires the current, active invoking Job".into());
        }
        let route = route_snapshot_from_job(&job).map_err(|e| e.to_string())?;
        let target = self
            .inner
            .store
            .get_execution_target(&job.target_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Execution Target not found")?;
        let profile = self.inner.permissions.profile_for_session(&job.session_id);
        self.inner
            .execution_targets
            .ensure_target_authorized(
                &target,
                Some(principal),
                &job.agent_id,
                &job.context_id,
                &job.thread_id,
            )
            .await
            .map_err(|e| e.to_string())?;
        if !current_local_workspace(&route, &target, &profile) {
            return Err("The invoking Job's workspace route is unavailable or changed; no Host-local fallback is allowed".into());
        }
        Ok(job)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    fn profile(root: &Path) -> PermissionProfile {
        let config = crate::permission::PermissionConfig {
            workspace_root: root.to_string_lossy().into_owned(),
            read_only_outside_workspace: false,
            ..Default::default()
        };
        PermissionProfile::from_config(&config).unwrap()
    }
    #[test]
    fn workspace_bytes_reuse_profile_and_preserve_unicode() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("史记.md"), "# 张仪\n原文").unwrap();
        let p = profile(root.path());
        let (name, bytes) = read_file(&p, "史记.md").unwrap();
        assert_eq!(name, "史记.md");
        assert_eq!(bytes, "# 张仪\n原文".as_bytes());
        for bad in [
            "../outside.md",
            "/tmp/outside.md",
            "./史记.md",
            "a/../史记.md",
            "",
            "a//b",
            "a\\b",
        ] {
            assert!(read_file(&p, bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn workspace_bytes_reject_links_protection_and_special_or_large_files() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("book.md"), "private").unwrap();
        symlink(outside.path(), root.path().join("escape")).unwrap();
        symlink(outside.path().join("book.md"), root.path().join("book.md")).unwrap();
        let mut p = profile(root.path());
        assert!(read_file(&p, "escape/book.md").is_err());
        assert!(read_file(&p, "book.md").is_err());
        std::fs::write(root.path().join("secret.md"), "private").unwrap();
        p.protected_paths.push("secret.md".into());
        assert!(read_file(&p, "secret.md").is_err());
        assert!(read_file(&p, "escape").is_err());
        std::fs::File::create(root.path().join("large.pdf"))
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        assert!(read_file(&p, "large.pdf").is_err());
    }
    #[test]
    fn workspace_read_requires_live_owner_call_and_lease() {
        let now = chrono::Utc::now();
        let mut job: ExecutionJobRecord = serde_json::from_value(serde_json::json!({
            "id":"job", "revision":1, "activation_id":"activation", "thread_id":"thread",
            "agent_id":"agent", "context_id":"context", "session_id":"session",
            "initiating_principal_id":"owner", "target_id":"target", "tool_call_id":"call",
            "tool_name":"host_morphz", "request":{}, "status":"running", "retry_safety":"idempotent",
            "result_refs":[], "created_at":now, "updated_at":now,
            "lease_expires_at":now + chrono::Duration::minutes(1)
        })).unwrap();
        assert!(active_invocation(&job, "owner", "call"));
        assert!(!active_invocation(&job, "other", "call"));
        assert!(!active_invocation(&job, "owner", "other-call"));
        job.cancel_requested_at = Some(now);
        assert!(!active_invocation(&job, "owner", "call"));
        job.cancel_requested_at = None;
        job.status = ExecutionJobStatus::Succeeded;
        assert!(!active_invocation(&job, "owner", "call"));
        job.status = ExecutionJobStatus::Running;
        job.lease_expires_at = Some(now - chrono::Duration::seconds(1));
        assert!(!active_invocation(&job, "owner", "call"));
    }
    #[test]
    fn workspace_read_never_reinterprets_remote_or_changed_routes_locally() {
        let root = tempfile::tempdir().unwrap();
        let p = profile(root.path());
        let mut target: ExecutionTargetRecord = serde_json::from_value(serde_json::json!({
            "id":"target", "revision":1, "kind":"in_process_local", "name":"local",
            "status":"online", "workspace_root":p.workspace_root, "capabilities":[],
            "metadata":{}, "policy_digest":"policy", "created_at":chrono::Utc::now(), "updated_at":chrono::Utc::now()
        })).unwrap();
        let mut route = ExecutionRouteSnapshot {
            route_id: "route".into(),
            target_id: "target".into(),
            target_revision: 1,
            provider_node_id: None,
            backend_kind: ExecutionTargetKind::InProcessLocal,
            endpoint_ref: None,
            policy_digest: "policy".into(),
        };
        assert!(current_local_workspace(&route, &target, &p));
        route.backend_kind = ExecutionTargetKind::EdgeNode;
        assert!(!current_local_workspace(&route, &target, &p));
        route.backend_kind = ExecutionTargetKind::InProcessLocal;
        route.provider_node_id = Some("other-node".into());
        assert!(!current_local_workspace(&route, &target, &p));
        route.provider_node_id = None;
        target.revision = 2;
        assert!(!current_local_workspace(&route, &target, &p));
        target.revision = 1;
        target.workspace_root = Some("/different/workspace".into());
        assert!(!current_local_workspace(&route, &target, &p));
    }
}
