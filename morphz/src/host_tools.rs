//! Explicit, host-owned loopback/local-IPC tool adapters. Project configuration cannot
//! install tools or supply their credentials. Calls remain physical jobs.
use std::{collections::HashSet, fs, path::Path, sync::Arc, time::Duration};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    llm::ToolDefinition,
    tool::{Tool, CURRENT_EXECUTION_JOB},
};

type Error = Box<dyn std::error::Error + Send + Sync>;
const MAX_MANIFEST: u64 = 256 * 1024;
const MAX_RESPONSE: usize = 2 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    protocol: u32,
    tools: Vec<Registration>,
    #[serde(default)]
    formats: Vec<crate::session_io::Descriptor>,
}

pub struct HostExtensions {
    pub tools: Vec<Arc<dyn Tool>>,
    pub formats: Vec<crate::session_io::Descriptor>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Registration {
    #[serde(default)]
    endpoint: String,
    #[serde(default)]
    ipc_path: Option<String>,
    token: String,
    context_ids: Vec<String>,
    #[serde(default)]
    context_id_prefixes: Vec<String>,
    definition: ToolDefinition,
}

impl Registration {
    fn validate_transport(&self) -> Result<(), Error> {
        if let Some(path) = &self.ipc_path {
            if !self.endpoint.is_empty() {
                return Err("host tool must select exactly one transport".into());
            }
            #[cfg(unix)]
            {
                let path = Path::new(path);
                if !path.is_absolute()
                    || path.as_os_str().len() > 103
                    || path.components().any(|c| {
                        matches!(
                            c,
                            std::path::Component::ParentDir | std::path::Component::CurDir
                        )
                    })
                    || path.to_string_lossy().chars().any(char::is_control)
                {
                    return Err(
                        "host tool IPC requires a bounded absolute local socket path".into(),
                    );
                }
                return Ok(());
            }
            #[cfg(not(unix))]
            return Err("host tool local IPC is not supported on this platform".into());
        }
        let url = reqwest::Url::parse(&self.endpoint).map_err(|_| "invalid host tool endpoint")?;
        // Numeric loopback only: no DNS rebinding, remote hosts, proxies or redirects.
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.port().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("host tools require an explicit numeric loopback HTTP endpoint".into());
        }
        Ok(())
    }
    fn allows_context(&self, id: &str) -> bool {
        self.context_ids.iter().any(|exact| exact == id)
            || self
                .context_id_prefixes
                .iter()
                .any(|prefix| id.len() > prefix.len() && id.starts_with(prefix))
    }
}

struct HostTool {
    registration: Registration,
    client: reqwest::Client,
    #[cfg(unix)]
    owner: Option<u32>,
}

#[cfg(unix)]
fn private_ipc_parent(path: &Path, owner: u32) -> Result<(), Error> {
    use std::os::unix::fs::MetadataExt;
    let parent = path.parent().ok_or("invalid IPC parent")?;
    let meta = fs::symlink_metadata(parent).map_err(|_| "cannot read IPC parent")?;
    if !meta.is_dir()
        || meta.uid() != owner
        || meta.mode() & 0o077 != 0
        || fs::canonicalize(parent).map_err(|_| "cannot resolve IPC parent")? != parent
    {
        return Err("host tool IPC parent must be private to the manifest owner".into());
    }
    Ok(())
}

impl HostTool {
    #[cfg(unix)]
    async fn local_request(&self, path: &str, request: &Value) -> Result<Vec<u8>, Error> {
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let path = Path::new(path);
        let owner = self.owner.ok_or("IPC manifest has no pinned owner")?;
        private_ipc_parent(path, owner)?;
        let meta = fs::symlink_metadata(path).map_err(|_| "host tool IPC is unavailable")?;
        if !meta.file_type().is_socket() || meta.uid() != owner {
            return Err("host tool IPC path is not an owner-controlled socket".into());
        }
        let bytes = serde_json::to_vec(
            &json!({ "protocol": 1, "token": self.registration.token, "request": request }),
        )?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err("host tool IPC request exceeds limit".into());
        }
        let operation = async {
            let mut socket = tokio::net::UnixStream::connect(path).await?;
            // Peer credentials prevent a path replacement from redirecting the private token.
            if socket.peer_cred()?.uid() != owner {
                return Err::<Vec<u8>, Error>("host tool IPC peer owner differs".into());
            }
            socket.write_u32(bytes.len() as u32).await?;
            socket.write_all(&bytes).await?;
            let length = socket.read_u32().await? as usize;
            if length == 0 || length > MAX_RESPONSE {
                return Err("host tool IPC response exceeds limit".into());
            }
            let mut result = vec![0; length];
            socket.read_exact(&mut result).await?;
            let mut extra = [0u8; 1];
            if socket.read(&mut extra).await? != 0 {
                return Err("host tool IPC returned multiple frames".into());
            }
            Ok(result)
        };
        let result = tokio::time::timeout(Duration::from_secs(20), operation)
            .await
            .map_err(|_| {
                "host tool IPC timed out; result is unknown, reconcile before repeating a write"
            })?
            .map_err(|_| {
                "host tool IPC failed; result is unknown, reconcile before repeating a write"
            })?;
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Reply {
            protocol: u32,
            ok: bool,
            value: Option<Value>,
            code: Option<String>,
        }
        let reply: Reply =
            serde_json::from_slice(&result).map_err(|_| "invalid host tool IPC response")?;
        if reply.protocol != 1 || !reply.ok || reply.code.is_some() {
            return Err("host tool IPC request rejected".into());
        }
        let value = reply.value.ok_or("host tool IPC returned no value")?;
        Ok(serde_json::to_vec(&value)?)
    }
}

fn validate(manifest: &Manifest) -> Result<(), Error> {
    if manifest.formats.len() > 32 {
        return Err("too many host format definitions".into());
    }
    let mut formats = crate::session_io::Registry::default();
    for format in &manifest.formats {
        formats.register(format.clone())?;
    }
    if manifest.protocol != 1 || manifest.tools.is_empty() || manifest.tools.len() > 16 {
        return Err("invalid host tool manifest version or count".into());
    }
    let mut names = HashSet::new();
    for tool in &manifest.tools {
        tool.validate_transport()?;
        let name = &tool.definition.name;
        if !name.starts_with("host_")
            || name.len() <= 5
            || name.len() > 64
            || !name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
            || !names.insert(name)
            || tool.definition.description.is_empty()
            || tool.definition.description.len() > 16_000
            || tool
                .definition
                .parameters
                .get("type")
                .and_then(Value::as_str)
                != Some("object")
            || tool.token.len() < 32
            || tool.token.len() > 1024
            || !tool.token.bytes().all(|c| c.is_ascii_graphic())
            || (tool.context_ids.is_empty() && tool.context_id_prefixes.is_empty())
            || tool.context_ids.len() > 100
            || tool.context_id_prefixes.len() > 100
            || tool.context_id_prefixes.iter().any(|prefix| {
                prefix.len() < 16
                    || prefix.len() > 512
                    || !prefix.ends_with('-')
                    || !prefix
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            })
            || tool
                .context_ids
                .iter()
                .any(|id| id.is_empty() || id.len() > 512 || id.chars().any(char::is_control))
        {
            return Err("invalid host tool definition, credential or context scope".into());
        }
    }
    Ok(())
}

/// Only the embedding host/CLI calls this, with an explicit absolute path.
/// The caller must protect this file and its private parent from Agent file access.
pub fn load(path: &Path) -> Result<Vec<Arc<dyn Tool>>, Error> {
    Ok(load_extensions(path)?.tools)
}

pub fn load_extensions(path: &Path) -> Result<HostExtensions, Error> {
    if !path.is_absolute() {
        return Err("host tool manifest path must be absolute".into());
    }
    let meta = fs::symlink_metadata(path).map_err(|_| "cannot read host tool manifest")?;
    if !meta.is_file() || meta.len() > MAX_MANIFEST {
        return Err("host tool manifest must be a bounded regular file, not a symlink".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            return Err("host tool manifest must be private to its owner (0600)".into());
        }
    }
    let bytes = fs::read(path).map_err(|_| "cannot read host tool manifest")?;
    if bytes.len() as u64 > MAX_MANIFEST {
        return Err("host tool manifest is too large".into());
    }
    let manifest: Manifest =
        serde_json::from_slice(&bytes).map_err(|_| "invalid host tool manifest JSON")?;
    validate(&manifest)?;
    #[cfg(unix)]
    let owner = {
        use std::os::unix::fs::MetadataExt;
        for tool in &manifest.tools {
            if let Some(ipc) = &tool.ipc_path {
                private_ipc_parent(Path::new(ipc), meta.uid())?;
            }
        }
        meta.uid()
    };
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()?;
    let tools = manifest
        .tools
        .into_iter()
        .map(|registration| {
            Arc::new(HostTool {
                registration,
                client: client.clone(),
                #[cfg(unix)]
                owner: Some(owner),
            }) as Arc<dyn Tool>
        })
        .collect();
    Ok(HostExtensions {
        tools,
        formats: manifest.formats,
    })
}

#[async_trait::async_trait]
impl Tool for HostTool {
    fn name(&self) -> &str {
        &self.registration.definition.name
    }
    fn definition(&self) -> ToolDefinition {
        self.registration.definition.clone()
    }
    // Conservative AtMostOnce default: each receiving host must additionally
    // deduplicate by the durable job ID before opting into stronger replay.
    async fn execute(&self, arguments: &str) -> Result<String, Error> {
        let route = CURRENT_EXECUTION_JOB
            .try_with(Clone::clone)
            .ok()
            .flatten()
            .ok_or("host tool requires a Runtime-owned ExecutionJob")?;
        if !self.registration.allows_context(&route.context_id)
            || route.session_id.is_empty()
            || route.parent_job_id.is_empty()
        {
            return Err("host tool is not authorized for this Context/Session".into());
        }
        if arguments.len() > 1024 * 1024 {
            return Err("host tool arguments exceed limit".into());
        }
        let arguments: Value = serde_json::from_str(arguments)?;
        if !arguments.is_object() {
            return Err("host tool arguments must be an object".into());
        }
        let envelope = json!({
            "protocol": 1, "tool": self.name(), "arguments": arguments,
            "invocation": {
                "job_id": route.parent_job_id, "tool_call_id": route.tool_call_id,
                "session_id": route.session_id, "context_id": route.context_id,
                "principal_id": route.initiating_principal_id, "agent_id": route.agent_id,
                "thread_id": route.thread_id, "target_id": route.target_id,
            }
        });
        #[cfg(unix)]
        if let Some(path) = &self.registration.ipc_path {
            let bytes = self.local_request(path, &envelope).await?;
            let result: Value = serde_json::from_slice(&bytes)?;
            return Ok(serde_json::to_string(&result)?);
        }
        let mut response = self
            .client
            .post(&self.registration.endpoint)
            .bearer_auth(&self.registration.token)
            .json(&envelope)
            .send()
            .await
            .map_err(|_| {
                "host tool transport failed; result is unknown, reconcile before repeating a write"
            })?;
        if !response.status().is_success() {
            // Do not reflect arbitrary proxy/endpoint bodies or credential-bearing URLs.
            return Err(format!(
                "host tool request rejected (HTTP {})",
                response.status().as_u16()
            )
            .into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "host tool response interrupted")?
        {
            if bytes.len() + chunk.len() > MAX_RESPONSE {
                return Err("host tool response exceeds limit".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let result: Value =
            serde_json::from_slice(&bytes).map_err(|_| "host tool returned invalid JSON")?;
        Ok(serde_json::to_string(&result)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn registration() -> Registration {
        Registration {
            endpoint: "http://127.0.0.1:65420/api/host-tools/call".into(),
            ipc_path: None,
            token: "x".repeat(64),
            context_ids: vec!["work-context".into()],
            context_id_prefixes: vec![],
            definition: ToolDefinition {
                name: "host_work".into(),
                description: "Work objects".into(),
                parameters: json!({"type":"object"}),
            },
        }
    }
    #[test]
    fn host_owned_context_namespace_is_delimited_and_not_a_wildcard() {
        let mut tool = registration();
        tool.context_ids.clear();
        tool.context_id_prefixes = vec!["work-center-unique-".into()];
        assert!(tool.allows_context("work-center-unique-project1"));
        assert!(!tool.allows_context("work-center-unique-"));
        assert!(!tool.allows_context("work-center-unique2-project1"));
        assert!(!tool.allows_context("another-center-project1"));
        let mut manifest = Manifest {
            protocol: 1,
            tools: vec![tool],
            formats: vec![],
        };
        assert!(validate(&manifest).is_ok());
        for prefix in [
            "",
            "*",
            "work-",
            "work-center-unique",
            "work-center-unique-*",
        ] {
            manifest.tools[0].context_id_prefixes = vec![prefix.into()];
            assert!(validate(&manifest).is_err());
        }
    }
    #[test]
    fn registration_cannot_replace_builtins_or_redirect_credentials() {
        let mut manifest = Manifest {
            protocol: 1,
            tools: vec![registration()],
            formats: vec![],
        };
        assert!(validate(&manifest).is_ok());
        for endpoint in [
            "https://example.org/tool",
            "http://localhost:1234/tool",
            "http://127.0.0.1/tool",
            "http://user@127.0.0.1:1234/tool",
            "http://127.0.0.1:1234/tool?token=secret",
        ] {
            manifest.tools[0].endpoint = endpoint.into();
            assert!(validate(&manifest).is_err());
        }
        manifest.tools[0] = registration();
        manifest.tools[0].definition.name = "exec_command".into();
        assert!(validate(&manifest).is_err());
        manifest.tools[0] = registration();
        manifest.tools[0].context_ids.clear();
        assert!(validate(&manifest).is_err());
        manifest.tools[0] = registration();
        manifest.tools.push(registration());
        assert!(validate(&manifest).is_err());
    }
    #[tokio::test]
    async fn calls_without_durable_job_fail_before_network() {
        let tool = HostTool {
            registration: registration(),
            client: reqwest::Client::new(),
            #[cfg(unix)]
            owner: None,
        };
        assert!(tool
            .execute("{}")
            .await
            .unwrap_err()
            .to_string()
            .contains("ExecutionJob"));
    }

    #[cfg(unix)]
    #[test]
    fn local_transport_is_explicit_and_parent_is_private() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let root = tempfile::Builder::new()
            .prefix("morphz-ipc-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = fs::canonicalize(root.path()).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let owner = fs::metadata(&root).unwrap().uid();
        let path = root.join("host.sock");
        let mut tool = registration();
        tool.ipc_path = Some(path.to_string_lossy().into());
        assert!(tool.validate_transport().is_err());
        tool.endpoint.clear();
        assert!(tool.validate_transport().is_ok());
        assert!(private_ipc_parent(&path, owner).is_ok());
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(private_ipc_parent(&path, owner).is_err());
        for path in ["relative.sock", "/tmp/../other.sock", "/tmp/bad\0.sock"] {
            tool.ipc_path = Some(path.into());
            assert!(tool.validate_transport().is_err());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_transport_preserves_actual_durable_job_and_bounded_reply() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let directory = tempfile::Builder::new()
            .prefix("morphz-ipc-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.join("host.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let size = socket.read_u32().await.unwrap() as usize;
            let mut bytes = vec![0; size];
            socket.read_exact(&mut bytes).await.unwrap();
            let request: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(request["token"], "x".repeat(64));
            assert_eq!(request["request"]["invocation"]["job_id"], "durable-job");
            assert_eq!(
                request["request"]["invocation"]["tool_call_id"],
                "actual-call"
            );
            assert_eq!(
                request["request"]["invocation"]["context_id"],
                "work-context"
            );
            assert_eq!(
                request["request"]["invocation"]["thread_id"],
                "actual-thread"
            );
            assert_eq!(
                request["request"]["invocation"]["principal_id"],
                "actual-human"
            );
            let reply = serde_json::to_vec(
                &json!({"protocol":1,"ok":true,"value":{"receipt":"saved-once"}}),
            )
            .unwrap();
            socket.write_u32(reply.len() as u32).await.unwrap();
            socket.write_all(&reply).await.unwrap();
            socket.shutdown().await.unwrap();
        });
        let mut registration = registration();
        registration.endpoint.clear();
        registration.ipc_path = Some(path.to_string_lossy().into());
        let tool = HostTool {
            registration,
            client: reqwest::Client::new(),
            owner: Some(fs::metadata(&root).unwrap().uid()),
        };
        let route = crate::tool::ToolExecutionJobContext {
            parent_job_id: "durable-job".into(),
            activation_id: "activation".into(),
            thread_id: "actual-thread".into(),
            agent_id: "actual-agent".into(),
            context_id: "work-context".into(),
            session_id: "actual-session".into(),
            initiating_principal_id: Some("actual-human".into()),
            target_id: "actual-target".into(),
            tool_call_id: "actual-call".into(),
        };
        let result = CURRENT_EXECUTION_JOB
            .scope(Some(route.clone()), tool.execute("{}"))
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&result).unwrap()["receipt"],
            "saved-once"
        );
        server.await.unwrap();
        let mut denied = route;
        denied.context_id = "foreign-context".into();
        assert!(CURRENT_EXECUTION_JOB
            .scope(Some(denied), tool.execute("{}"))
            .await
            .unwrap_err()
            .to_string()
            .contains("not authorized"));
        // Refused connection yields unknown, not a retry or a fabricated success.
        assert!(tool
            .local_request(path.to_str().unwrap(), &json!({}))
            .await
            .unwrap_err()
            .to_string()
            .contains("unknown"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_transport_rejects_oversize_frames_without_allocating_them() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let directory = tempfile::Builder::new()
            .prefix("morphz-ipc-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.join("host.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let size = socket.read_u32().await.unwrap() as usize;
            let mut request = vec![0; size];
            socket.read_exact(&mut request).await.unwrap();
            socket.write_u32(u32::MAX).await.unwrap();
            socket.shutdown().await.unwrap();
        });
        let tool = HostTool {
            registration: registration(),
            client: reqwest::Client::new(),
            owner: Some(fs::metadata(&root).unwrap().uid()),
        };
        assert!(tool
            .local_request(path.to_str().unwrap(), &json!({}))
            .await
            .is_err());
        server.await.unwrap();
    }
}
