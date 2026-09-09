//! Explicit, host-owned loopback tool adapters. Project configuration cannot
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
    endpoint: String,
    token: String,
    context_ids: Vec<String>,
    #[serde(default)]
    context_id_prefixes: Vec<String>,
    definition: ToolDefinition,
}

impl Registration {
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
        let url = reqwest::Url::parse(&tool.endpoint).map_err(|_| "invalid host tool endpoint")?;
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
        };
        assert!(tool
            .execute("{}")
            .await
            .unwrap_err()
            .to_string()
            .contains("ExecutionJob"));
    }
}
