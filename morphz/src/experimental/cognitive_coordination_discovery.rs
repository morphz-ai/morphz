//! Coordination Mesh discovery providers.
//!
//! Discovery only yields operator-authorized candidate endpoints. It never
//! authenticates a node and never gates local Runtime startup. The transport
//! establishes cryptographic identity after resolving candidates.

use async_trait::async_trait;
use serde::Deserialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

type DynError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoordinationEndpoint {
    pub base_url: String,
}

#[async_trait]
pub trait CoordinationDiscoveryProvider: Send + Sync {
    async fn resolve(&self) -> Result<Vec<CoordinationEndpoint>, DynError>;
    fn source_label(&self) -> String;
}

#[derive(Debug, Clone)]
pub struct StaticDiscovery {
    endpoints: Vec<CoordinationEndpoint>,
}

impl StaticDiscovery {
    fn new(endpoints: Vec<CoordinationEndpoint>) -> Result<Self, DynError> {
        let endpoints = normalize_endpoints(endpoints)?;
        Ok(Self { endpoints })
    }
}

#[async_trait]
impl CoordinationDiscoveryProvider for StaticDiscovery {
    async fn resolve(&self) -> Result<Vec<CoordinationEndpoint>, DynError> {
        Ok(self.endpoints.clone())
    }

    fn source_label(&self) -> String {
        "static".to_string()
    }
}

#[derive(Debug, Clone)]
pub struct FileDiscovery {
    path: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MeshFile {
    version: u32,
    members: Vec<String>,
}

impl FileDiscovery {
    fn new(path: PathBuf) -> Result<Self, DynError> {
        if path.as_os_str().is_empty() {
            return Err("Coordination Mesh file path must not be empty".into());
        }
        Ok(Self { path })
    }

    fn read(path: &Path) -> Result<Vec<CoordinationEndpoint>, DynError> {
        let contents = std::fs::read_to_string(path).map_err(|error| {
            format!(
                "failed to read Coordination Mesh file '{}': {error}",
                path.display()
            )
        })?;
        let file: MeshFile = toml::from_str(&contents).map_err(|error| {
            format!(
                "failed to parse Coordination Mesh file '{}': {error}",
                path.display()
            )
        })?;
        if file.version != 1 {
            return Err(format!(
                "unsupported Coordination Mesh file version {}; expected 1",
                file.version
            )
            .into());
        }
        let endpoints = file
            .members
            .into_iter()
            .map(|base_url| CoordinationEndpoint { base_url })
            .collect::<Vec<_>>();
        normalize_endpoints(endpoints)
    }
}

#[async_trait]
impl CoordinationDiscoveryProvider for FileDiscovery {
    async fn resolve(&self) -> Result<Vec<CoordinationEndpoint>, DynError> {
        let path = self.path.clone();
        tokio::task::spawn_blocking(move || Self::read(&path))
            .await
            .map_err(|error| format!("Coordination Mesh file task failed: {error}"))?
    }

    fn source_label(&self) -> String {
        format!("file:{}", self.path.display())
    }
}

pub fn provider_from_spec(
    spec: &str,
) -> Result<std::sync::Arc<dyn CoordinationDiscoveryProvider>, DynError> {
    let spec = spec.trim();
    if let Some(value) = spec.strip_prefix("static:") {
        let endpoints = value
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|base_url| CoordinationEndpoint {
                base_url: base_url.to_string(),
            })
            .collect::<Vec<_>>();
        return Ok(std::sync::Arc::new(StaticDiscovery::new(endpoints)?));
    }
    if let Some(value) = spec.strip_prefix("file:") {
        return Ok(std::sync::Arc::new(FileDiscovery::new(PathBuf::from(
            value,
        ))?));
    }
    if spec.starts_with("etcd://") {
        return Err("etcd is not available as a Coordination Mesh source in this experimental build; use static: or file:".into());
    }
    Err("Coordination Mesh source must use static:URL,URL or file:PATH".into())
}

fn normalize_endpoints(
    endpoints: Vec<CoordinationEndpoint>,
) -> Result<Vec<CoordinationEndpoint>, DynError> {
    if endpoints.is_empty() {
        return Err("Coordination Mesh must contain at least one member endpoint".into());
    }
    let mut unique = BTreeSet::new();
    let mut normalized_endpoints = Vec::with_capacity(endpoints.len());
    for endpoint in endpoints {
        let normalized = normalize_base_url(&endpoint.base_url)?;
        if !unique.insert(normalized.clone()) {
            return Err(
                format!("Coordination Mesh contains duplicate endpoint '{normalized}'").into(),
            );
        }
        normalized_endpoints.push(CoordinationEndpoint {
            base_url: normalized,
        });
    }
    Ok(normalized_endpoints)
}

pub fn normalize_base_url(value: &str) -> Result<String, DynError> {
    let mut url = reqwest::Url::parse(value.trim())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!(
            "Coordination Mesh endpoint '{}' must use http or https",
            value.trim()
        )
        .into());
    }
    if url.cannot_be_a_base() || url.host_str().is_none() {
        return Err(format!(
            "Coordination Mesh endpoint '{}' is not an absolute base URL",
            value.trim()
        )
        .into());
    }
    url.set_query(None);
    url.set_fragment(None);
    let normalized = url.as_str().trim_end_matches('/').to_string();
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn static_provider_normalizes_a_repeatable_member_set() {
        let provider =
            provider_from_spec("static:http://127.0.0.1:8080,http://127.0.0.1:8081/").unwrap();
        let endpoints = provider.resolve().await.unwrap();
        assert_eq!(endpoints.len(), 2);
        assert_eq!(endpoints[0].base_url, "http://127.0.0.1:8080");
        assert_eq!(endpoints[1].base_url, "http://127.0.0.1:8081");
        assert_eq!(provider.source_label(), "static");
    }

    #[tokio::test]
    async fn file_provider_reloads_changed_members() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mesh.toml");
        std::fs::write(&path, "version = 1\nmembers = ['http://127.0.0.1:8080']\n").unwrap();
        let provider = provider_from_spec(&format!("file:{}", path.display())).unwrap();
        assert_eq!(provider.resolve().await.unwrap().len(), 1);
        std::fs::write(
            &path,
            "version = 1\nmembers = ['http://127.0.0.1:8080', 'http://127.0.0.1:8081']\n",
        )
        .unwrap();
        assert_eq!(provider.resolve().await.unwrap().len(), 2);
    }

    #[test]
    fn duplicate_and_non_http_members_fail_closed() {
        assert!(provider_from_spec("static:http://a:8080,http://a:8080/").is_err());
        assert!(provider_from_spec("static:ssh://a").is_err());
    }
}
