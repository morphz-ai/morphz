//! Runtime-managed secret references.
//!
//! Metadata is safe to inspect and is stored separately from secret values.
//! Values live behind pluggable [`SecretValueBackend`] implementations. Each
//! credential explicitly records its value backend; Morphz never silently
//! changes storage when a backend is unavailable.

use crate::config::{host_env_path, host_state_path};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

const NATIVE_KEYRING_SERVICE: &str = "ai.morphz.runtime.secrets.v1";
pub const HOST_ENV_FILE_SECRET_BACKEND_ID: &str = "morphz_env_file";
const MAX_USAGE_AUDIT_BYTES: u64 = 4 * 1024 * 1024;
const RETAINED_USAGE_AUDIT_RECORDS: usize = 2_000;
const BACKEND_OPERATION_TIMEOUT: Duration = Duration::from_secs(15);
const NATIVE_KEYRING_OPERATION_TIMEOUT: Duration = Duration::from_secs(120);
const BACKEND_OPERATION_IDLE: u8 = 0;
const BACKEND_OPERATION_IN_FLIGHT: u8 = 1;
const BACKEND_OPERATION_STALLED: u8 = 2;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SecretScopeKind {
    Runtime,
    Context,
    Session,
    Objective,
    ExecutionTarget,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ManagedSecret {
    /// Environment-variable alias exposed to the model and permission system.
    pub name: String,
    /// Stable opaque reference. The value can never be resolved through HTTP.
    pub secret_ref: String,
    pub scope_kind: SecretScopeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
    /// Operator-facing backend identity; never contains credential material.
    #[serde(default = "default_value_backend")]
    pub value_backend: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct SecretBackendStatus {
    pub id: String,
    pub storage_kind: String,
    pub available: bool,
    pub writable: bool,
    pub supports_import: bool,
    pub detail: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct SecretImportCandidate {
    pub name: String,
    pub value_backend: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct SecretUseAuditRecord {
    pub name: String,
    pub secret_ref: String,
    pub value_backend: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub objective_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    pub used_at: chrono::DateTime<chrono::Utc>,
}

fn default_value_backend() -> String {
    "native_keyring".to_string()
}

#[derive(Clone, Debug, Default)]
pub struct SecretUseContext<'a> {
    pub context_id: Option<&'a str>,
    pub session_id: Option<&'a str>,
    pub objective_id: Option<&'a str>,
    pub target_id: Option<&'a str>,
}

/// Storage boundary for secret values. Server and Edge hosts can inject a
/// Vault/KMS/target-local implementation without changing SDK, HTTP or tools.
pub trait SecretValueBackend: Send + Sync {
    fn backend_id(&self) -> &'static str;
    fn storage_kind(&self) -> &'static str;
    fn put(&self, locator: &str, value: &str) -> Result<(), String>;
    fn get(&self, locator: &str) -> Result<Option<String>, String>;
    fn delete(&self, locator: &str) -> Result<bool, String>;
    fn list_aliases(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn supports_import(&self) -> bool {
        false
    }
    fn status_detail(&self) -> String {
        self.backend_id().to_string()
    }
}

/// Native cross-platform backend:
/// - macOS: Keychain Services
/// - Windows: Credential Manager
/// - Linux/*nix: Secret Service
///
/// An unavailable or locked native store is an explicit error. In particular,
/// headless Linux does not silently degrade to a plaintext file.
#[derive(Debug, Default)]
pub struct NativeKeyringSecretBackend;

impl NativeKeyringSecretBackend {
    fn entry(locator: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(NATIVE_KEYRING_SERVICE, locator)
            .map_err(|error| native_backend_error("open", error))
    }
}

impl SecretValueBackend for NativeKeyringSecretBackend {
    fn backend_id(&self) -> &'static str {
        #[cfg(target_os = "macos")]
        {
            "macos_keychain"
        }
        #[cfg(target_os = "windows")]
        {
            "windows_credential_manager"
        }
        #[cfg(all(
            unix,
            not(any(target_os = "macos", target_os = "ios", target_os = "android"))
        ))]
        {
            "secret_service"
        }
        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            all(
                unix,
                not(any(target_os = "macos", target_os = "ios", target_os = "android"))
            )
        )))]
        {
            "unsupported_native_store"
        }
    }

    fn storage_kind(&self) -> &'static str {
        "native_keyring"
    }

    fn put(&self, locator: &str, value: &str) -> Result<(), String> {
        Self::entry(locator)?
            .set_password(value)
            .map_err(|error| native_backend_error("write to", error))
    }

    fn get(&self, locator: &str) -> Result<Option<String>, String> {
        match Self::entry(locator)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(native_backend_error("read from", error)),
        }
    }

    fn delete(&self, locator: &str) -> Result<bool, String> {
        match Self::entry(locator)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(error) => Err(native_backend_error("delete from", error)),
        }
    }

    fn status_detail(&self) -> String {
        "operating-system user credential store; it may be unavailable in background, SSH, or headless sessions".to_string()
    }
}

fn native_backend_error(operation: &str, error: keyring::Error) -> String {
    format!(
        "failed to {operation} the system credential store: {error}. macOS requires an accessible Keychain, Windows requires Credential Manager, and Linux requires an available Secret Service/D-Bus; Morphz will not fall back to a plaintext file"
    )
}

/// Explicit plaintext backend for the Morphz-owned host environment file.
///
/// This backend exists for headless deployments where a desktop credential
/// service is unavailable. It is never selected as an implicit fallback.
#[derive(Debug)]
pub struct HostEnvFileSecretBackend {
    path: PathBuf,
    lock: Mutex<()>,
}

impl HostEnvFileSecretBackend {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            lock: Mutex::new(()),
        }
    }

    fn read_lines(&self) -> Result<Vec<String>, String> {
        match fs::read_to_string(&self.path) {
            Ok(contents) => Ok(contents.lines().map(ToString::to_string).collect()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(error) => Err(format!(
                "failed to read Morphz environment file '{}': {error}",
                self.path.display()
            )),
        }
    }

    fn persist_lines(&self, lines: &[String]) -> Result<(), String> {
        let mut contents = lines.join("\n");
        if !contents.is_empty() {
            contents.push('\n');
        }
        atomic_private_write(&self.path, contents.as_bytes())
    }
}

impl SecretValueBackend for HostEnvFileSecretBackend {
    fn backend_id(&self) -> &'static str {
        HOST_ENV_FILE_SECRET_BACKEND_ID
    }

    fn storage_kind(&self) -> &'static str {
        "host_env_file"
    }

    fn put(&self, locator: &str, value: &str) -> Result<(), String> {
        validate_env_file_value(value)?;
        let name = locator_name(locator)?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "Morphz environment file lock is poisoned".to_string())?;
        let mut lines = self.read_lines()?;
        let replacement = format!("{name}={}", quote_env_value(value));
        let mut replaced = false;
        for line in &mut lines {
            if env_assignment_name(line) == Some(name) {
                *line = replacement.clone();
                replaced = true;
            }
        }
        if !replaced {
            lines.push(replacement);
        }
        self.persist_lines(&lines)
    }

    fn get(&self, locator: &str) -> Result<Option<String>, String> {
        let name = locator_name(locator)?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "Morphz environment file lock is poisoned".to_string())?;
        for line in self.read_lines()?.iter().rev() {
            if env_assignment_name(line) == Some(name) {
                let (_, value) = line.trim().split_once('=').ok_or_else(|| {
                    format!("environment variable '{name}' has an invalid format")
                })?;
                return crate::config::parse_env_value(value)
                    .map(Some)
                    .map_err(|error| {
                        format!("failed to parse environment variable '{name}': {error}")
                    });
            }
        }
        Ok(None)
    }

    fn delete(&self, locator: &str) -> Result<bool, String> {
        let name = locator_name(locator)?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "Morphz environment file lock is poisoned".to_string())?;
        let mut lines = self.read_lines()?;
        let previous_len = lines.len();
        lines.retain(|line| env_assignment_name(line) != Some(name));
        if lines.len() == previous_len {
            return Ok(false);
        }
        self.persist_lines(&lines)?;
        Ok(true)
    }

    fn list_aliases(&self) -> Result<Vec<String>, String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "Morphz environment file lock is poisoned".to_string())?;
        let mut aliases = self
            .read_lines()?
            .iter()
            .filter_map(|line| env_assignment_name(line).map(ToString::to_string))
            .collect::<Vec<_>>();
        aliases.sort();
        aliases.dedup();
        Ok(aliases)
    }

    fn supports_import(&self) -> bool {
        true
    }

    fn status_detail(&self) -> String {
        format!(
            "Morphz host environment file '{}' (plaintext with file mode 0600)",
            self.path.display()
        )
    }
}

/// Metadata catalog plus explicitly selected value backends. One Runtime owns
/// one store.
pub struct SecretStore {
    catalog_path: PathBuf,
    audit_path: PathBuf,
    default_backend_id: String,
    backends: BTreeMap<String, Arc<dyn SecretValueBackend>>,
    backend_operation_states: BTreeMap<String, Arc<AtomicU8>>,
    backend_operation_timeout: Duration,
    native_keyring_operation_timeout: Duration,
    catalog: RwLock<BTreeMap<String, ManagedSecret>>,
    audit_lock: Mutex<()>,
}

impl std::fmt::Debug for SecretStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SecretStore")
            .field("catalog_path", &self.catalog_path)
            .field("default_backend", &self.default_backend_id)
            .field("backends", &self.backends.keys().collect::<Vec<_>>())
            .finish_non_exhaustive()
    }
}

impl SecretStore {
    pub fn native_default() -> Result<Self, String> {
        let catalog_path = host_state_path("managed-secrets.json")
            .ok_or_else(|| "cannot determine Morphz user configuration directory".to_string())?;
        let env_path = host_env_path()
            .ok_or_else(|| "cannot determine Morphz user environment file".to_string())?;
        let native: Arc<dyn SecretValueBackend> = Arc::new(NativeKeyringSecretBackend);
        let default_backend_id = native.backend_id().to_string();
        Self::with_backends(
            catalog_path,
            default_backend_id,
            vec![native, Arc::new(HostEnvFileSecretBackend::new(env_path))],
        )
    }

    pub fn new(
        catalog_path: impl Into<PathBuf>,
        backend: Arc<dyn SecretValueBackend>,
    ) -> Result<Self, String> {
        let default_backend_id = backend.backend_id().to_string();
        Self::with_backends(catalog_path, default_backend_id, vec![backend])
    }

    pub fn with_backends(
        catalog_path: impl Into<PathBuf>,
        default_backend_id: impl Into<String>,
        backends: Vec<Arc<dyn SecretValueBackend>>,
    ) -> Result<Self, String> {
        Self::with_backends_and_timeouts(
            catalog_path,
            default_backend_id,
            backends,
            BACKEND_OPERATION_TIMEOUT,
            NATIVE_KEYRING_OPERATION_TIMEOUT,
        )
    }

    #[cfg(test)]
    fn with_backends_and_timeout(
        catalog_path: impl Into<PathBuf>,
        default_backend_id: impl Into<String>,
        backends: Vec<Arc<dyn SecretValueBackend>>,
        backend_operation_timeout: Duration,
    ) -> Result<Self, String> {
        Self::with_backends_and_timeouts(
            catalog_path,
            default_backend_id,
            backends,
            backend_operation_timeout,
            backend_operation_timeout,
        )
    }

    fn with_backends_and_timeouts(
        catalog_path: impl Into<PathBuf>,
        default_backend_id: impl Into<String>,
        backends: Vec<Arc<dyn SecretValueBackend>>,
        backend_operation_timeout: Duration,
        native_keyring_operation_timeout: Duration,
    ) -> Result<Self, String> {
        let catalog_path = catalog_path.into();
        let audit_path = catalog_path.with_file_name("managed-secret-usage.jsonl");
        let entries = match fs::read(&catalog_path) {
            Ok(bytes) => serde_json::from_slice::<Vec<ManagedSecret>>(&bytes)
                .map_err(|error| format!("failed to parse Secret metadata catalog: {error}"))?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(format!("failed to read Secret metadata catalog: {error}")),
        };
        let catalog = entries
            .into_iter()
            .map(|entry| (entry.name.clone(), entry))
            .collect();
        let backends = backends
            .into_iter()
            .map(|backend| (backend.backend_id().to_string(), backend))
            .collect::<BTreeMap<_, _>>();
        let default_backend_id = default_backend_id.into();
        if !backends.contains_key(&default_backend_id) {
            return Err(format!(
                "default Secret Value Backend '{default_backend_id}' is not registered"
            ));
        }
        let backend_operation_states = backends
            .keys()
            .cloned()
            .map(|backend_id| (backend_id, Arc::new(AtomicU8::new(BACKEND_OPERATION_IDLE))))
            .collect();
        Ok(Self {
            catalog_path,
            audit_path,
            default_backend_id,
            backends,
            backend_operation_states,
            backend_operation_timeout: backend_operation_timeout.max(Duration::from_millis(1)),
            native_keyring_operation_timeout: native_keyring_operation_timeout
                .max(Duration::from_millis(1)),
            catalog: RwLock::new(catalog),
            audit_lock: Mutex::new(()),
        })
    }

    pub fn backend_id(&self) -> &str {
        &self.default_backend_id
    }

    pub fn has_backend(&self, backend_id: &str) -> bool {
        self.backend(backend_id).is_ok()
    }

    pub fn backend_storage_kind(&self, backend_id: &str) -> Option<&'static str> {
        self.backend(backend_id)
            .ok()
            .map(|backend| backend.storage_kind())
    }

    pub fn backend_statuses(&self) -> Vec<SecretBackendStatus> {
        self.backends
            .values()
            .map(|backend| {
                let backend = Arc::clone(backend);
                let backend_id = backend.backend_id().to_string();
                let storage_kind = backend.storage_kind().to_string();
                let supports_import = backend.supports_import();
                let status_detail = backend.status_detail();
                let health = self.run_backend_operation(&backend_id, "health check", move || {
                    backend.get(&secret_locator("__MORPHZ_BACKEND_HEALTH_CHECK__"))
                });
                SecretBackendStatus {
                    id: backend_id,
                    storage_kind,
                    available: health.is_ok(),
                    writable: health.is_ok(),
                    supports_import,
                    detail: health.err().unwrap_or(status_detail),
                }
            })
            .collect()
    }

    pub fn import_candidates(&self) -> Result<Vec<SecretImportCandidate>, String> {
        let managed = self
            .catalog
            .read()
            .map_err(|_| "Secret metadata catalog lock is poisoned".to_string())?;
        let mut candidates = Vec::new();
        for backend in self
            .backends
            .values()
            .filter(|backend| backend.supports_import())
        {
            let backend = Arc::clone(backend);
            let backend_id = backend.backend_id().to_string();
            let names = self.run_backend_operation(&backend_id, "list aliases", move || {
                backend.list_aliases()
            })?;
            for name in names {
                if validate_name(&name).is_ok() && !managed.contains_key(&name) {
                    candidates.push(SecretImportCandidate {
                        name,
                        value_backend: backend_id.clone(),
                    });
                }
            }
        }
        candidates.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(candidates)
    }

    pub fn list(&self) -> Result<Vec<ManagedSecret>, String> {
        Ok(self
            .catalog
            .read()
            .map_err(|_| "Secret metadata catalog lock is poisoned".to_string())?
            .values()
            .cloned()
            .collect())
    }

    pub fn list_authorized(
        &self,
        usage: SecretUseContext<'_>,
    ) -> Result<Vec<ManagedSecret>, String> {
        Ok(self
            .catalog
            .read()
            .map_err(|_| "Secret metadata catalog lock is poisoned".to_string())?
            .values()
            .filter(|entry| authorize_entry(entry, usage.clone()).is_ok())
            .cloned()
            .collect())
    }

    pub fn put(
        &self,
        name: &str,
        value: &str,
        scope_kind: SecretScopeKind,
        scope_id: Option<String>,
    ) -> Result<ManagedSecret, String> {
        self.put_with_backend(name, value, scope_kind, scope_id, &self.default_backend_id)
    }

    pub fn put_with_backend(
        &self,
        name: &str,
        value: &str,
        scope_kind: SecretScopeKind,
        scope_id: Option<String>,
        value_backend: &str,
    ) -> Result<ManagedSecret, String> {
        self.put_with_backend_policy(name, value, scope_kind, scope_id, value_backend, true)
    }

    #[cfg(feature = "experimental-cognitive-coordination")]
    pub(crate) fn copy_to_backend_retaining_previous(
        &self,
        name: &str,
        value: &str,
        scope_kind: SecretScopeKind,
        scope_id: Option<String>,
        value_backend: &str,
    ) -> Result<ManagedSecret, String> {
        self.put_with_backend_policy(name, value, scope_kind, scope_id, value_backend, false)
    }

    fn put_with_backend_policy(
        &self,
        name: &str,
        value: &str,
        scope_kind: SecretScopeKind,
        scope_id: Option<String>,
        value_backend: &str,
        cleanup_previous: bool,
    ) -> Result<ManagedSecret, String> {
        validate_name(name)?;
        validate_value(value)?;
        validate_scope(&scope_kind, scope_id.as_deref())?;

        let backend = self.backend(value_backend)?;
        let backend_id = backend.backend_id().to_string();
        let locator = secret_locator(name);
        // Persist the value first. The catalog never contains the value and a
        // catalog failure can at worst leave an unreachable credential.
        let backend_for_put = Arc::clone(&backend);
        let locator_for_put = locator.clone();
        let value_for_put = zeroize::Zeroizing::new(value.to_string());
        self.run_backend_operation(&backend_id, "write", move || {
            backend_for_put.put(&locator_for_put, value_for_put.as_str())
        })?;

        let now = chrono::Utc::now();
        let mut guard = self
            .catalog
            .write()
            .map_err(|_| "Secret metadata catalog lock is poisoned".to_string())?;
        let previous = guard.get(name).cloned();
        let created_at = previous
            .as_ref()
            .map(|entry| entry.created_at)
            .unwrap_or(now);
        let entry = ManagedSecret {
            name: name.to_string(),
            secret_ref: format!("secret://runtime/{name}"),
            scope_kind,
            scope_id,
            value_backend: backend_id.clone(),
            created_at,
            updated_at: now,
        };
        let mut next = guard.clone();
        next.insert(name.to_string(), entry.clone());
        self.persist_catalog(next.values())?;
        *guard = next;
        drop(guard);
        if let Some(previous) =
            previous.filter(|entry| cleanup_previous && entry.value_backend != backend_id)
        {
            let cleanup = self.backend(&previous.value_backend).and_then(|backend| {
                let previous_backend_id = backend.backend_id().to_string();
                let locator = locator.clone();
                self.run_backend_operation(&previous_backend_id, "remove old value", move || {
                    backend.delete(&locator).map(|_| ())
                })
            });
            if let Err(error) = cleanup {
                tracing::warn!(
                    alias = name,
                    previous_backend = previous.value_backend,
                    error,
                event_code = "secret_store.backend_switch.cleanup_failed",
                "Managed secret changed value backend but the old backend value could not be removed automatically"
                );
            }
        }
        Ok(entry)
    }

    pub fn import(
        &self,
        name: &str,
        scope_kind: SecretScopeKind,
        scope_id: Option<String>,
        value_backend: &str,
    ) -> Result<ManagedSecret, String> {
        validate_name(name)?;
        validate_scope(&scope_kind, scope_id.as_deref())?;
        let backend = self.backend(value_backend)?;
        let backend_id = backend.backend_id().to_string();
        if !backend.supports_import() {
            return Err(format!(
                "Secret Value Backend '{}' does not support importing an existing alias",
                backend.backend_id()
            ));
        }
        let locator = secret_locator(name);
        let backend_for_get = Arc::clone(&backend);
        let locator_for_get = locator.clone();
        let value = zeroize::Zeroizing::new(
            self.run_backend_operation(&backend_id, "read for import", move || {
                backend_for_get.get(&locator_for_get)
            })?
            .ok_or_else(|| format!("alias '{name}' does not exist in backend '{backend_id}'"))?,
        );
        validate_value(value.as_str())?;
        let now = chrono::Utc::now();
        let mut guard = self
            .catalog
            .write()
            .map_err(|_| "Secret metadata catalog lock is poisoned".to_string())?;
        let created_at = guard.get(name).map(|entry| entry.created_at).unwrap_or(now);
        let entry = ManagedSecret {
            name: name.to_string(),
            secret_ref: format!("secret://runtime/{name}"),
            scope_kind,
            scope_id,
            value_backend: backend_id,
            created_at,
            updated_at: now,
        };
        let mut next = guard.clone();
        next.insert(name.to_string(), entry.clone());
        self.persist_catalog(next.values())?;
        *guard = next;
        Ok(entry)
    }

    pub fn delete(&self, name: &str) -> Result<bool, String> {
        let mut guard = self
            .catalog
            .write()
            .map_err(|_| "Secret metadata catalog lock is poisoned".to_string())?;
        let Some(entry) = guard.get(name).cloned() else {
            return Ok(false);
        };
        let backend = self.backend(&entry.value_backend)?;
        let backend_id = backend.backend_id().to_string();
        let locator = secret_locator(name);
        self.run_backend_operation(&backend_id, "delete", move || backend.delete(&locator))?;
        let mut next = guard.clone();
        next.remove(name);
        self.persist_catalog(next.values())?;
        *guard = next;
        Ok(true)
    }

    /// Resolve one approved alias. Managed aliases use the backend explicitly
    /// recorded in metadata. Unregistered process environment variables remain
    /// a bootstrap-only compatibility path and are intentionally undiscoverable.
    pub fn resolve(
        &self,
        name: &str,
        usage: SecretUseContext<'_>,
    ) -> Result<Option<String>, String> {
        validate_name(name)?;
        let entry = self
            .catalog
            .read()
            .map_err(|_| "Secret metadata catalog lock is poisoned".to_string())?
            .get(name)
            .cloned();
        let Some(entry) = entry else {
            return std::env::var(name).map(Some).or_else(|error| match error {
                std::env::VarError::NotPresent => Ok(None),
                std::env::VarError::NotUnicode(_) => Err(format!(
                    "environment variable '{name}' is not valid Unicode"
                )),
            });
        };
        authorize_entry(&entry, usage.clone())?;
        let backend = self.backend(&entry.value_backend)?;
        let backend_id = backend.backend_id().to_string();
        let locator = secret_locator(name);
        let value = self
            .run_backend_operation(&backend_id, "read", move || backend.get(&locator))?
            .ok_or_else(|| {
                format!(
                    "managed credential '{}' has metadata but no corresponding value in backend '{}'",
                    entry.secret_ref, entry.value_backend
                )
            })?;
        if value.is_empty() {
            return Err(format!(
                "managed credential '{}' has an empty value",
                entry.secret_ref
            ));
        }
        let _ = self.append_usage_audit(&entry, usage);
        Ok(Some(value))
    }

    pub fn contains_alias(&self, name: &str) -> Result<bool, String> {
        validate_name(name)?;
        if self
            .catalog
            .read()
            .map_err(|_| "Secret metadata catalog lock is poisoned".to_string())?
            .contains_key(name)
        {
            return Ok(true);
        }
        Ok(std::env::var_os(name).is_some())
    }

    pub fn recent_usage(&self, limit: usize) -> Result<Vec<SecretUseAuditRecord>, String> {
        let _guard = self
            .audit_lock
            .lock()
            .map_err(|_| "Secret usage audit lock is poisoned".to_string())?;
        let contents = match fs::read_to_string(&self.audit_path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(format!("failed to read Secret usage audit: {error}")),
        };
        Ok(contents
            .lines()
            .rev()
            .filter_map(|line| serde_json::from_str(line).ok())
            .take(limit.clamp(1, 500))
            .collect())
    }

    fn backend(&self, value_backend: &str) -> Result<Arc<dyn SecretValueBackend>, String> {
        self.backends
            .get(value_backend)
            .or_else(|| {
                (value_backend == "native_keyring")
                    .then(|| self.backends.get(&self.default_backend_id))
                    .flatten()
            })
            .cloned()
            .ok_or_else(|| format!("Secret Value Backend '{value_backend}' is not registered"))
    }

    fn operation_timeout_for_backend(&self, backend_id: &str) -> Duration {
        self.backends
            .get(backend_id)
            .filter(|backend| backend.storage_kind() == "native_keyring")
            .map(|_| self.native_keyring_operation_timeout)
            .unwrap_or(self.backend_operation_timeout)
    }

    /// Runs a potentially interactive or remote backend outside Tokio's blocking pool.
    ///
    /// Tokio waits indefinitely for `spawn_blocking` work while dropping a Runtime. A
    /// platform credential API can wait for UI authorization forever, so owning that
    /// call from Tokio turns an already-received Ctrl-C into an unbounded shutdown.
    /// Detached standard threads do not participate in Runtime shutdown. A per-backend
    /// gate also prevents one stalled OS credential request from accumulating more
    /// permanently blocked threads.
    fn run_backend_operation<T, F>(
        &self,
        backend_id: &str,
        operation: &str,
        callback: F,
    ) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T, String> + Send + 'static,
    {
        let operation_timeout = self.operation_timeout_for_backend(backend_id);
        let state = self
            .backend_operation_states
            .get(backend_id)
            .cloned()
            .ok_or_else(|| format!("Secret Value Backend '{backend_id}' has no operation state"))?;
        let started = Instant::now();
        loop {
            match state.compare_exchange(
                BACKEND_OPERATION_IDLE,
                BACKEND_OPERATION_IN_FLIGHT,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(BACKEND_OPERATION_STALLED) => {
                    return Err(format!(
                        "Secret Value Backend '{backend_id}' still has a timed-out operation in progress and is temporarily isolated by the Runtime; complete or dismiss the system credential-store prompt before retrying"
                    ));
                }
                Err(BACKEND_OPERATION_IN_FLIGHT) => {
                    let Some(remaining) = operation_timeout.checked_sub(started.elapsed()) else {
                        return Err(format!(
                            "Secret Value Backend '{backend_id}' waited more than {} ms to {operation}; another backend operation is still in progress",
                            operation_timeout.as_millis()
                        ));
                    };
                    std::thread::sleep(remaining.min(Duration::from_millis(10)));
                }
                Err(other) => {
                    return Err(format!(
                        "Secret Value Backend '{backend_id}' has an invalid operation state: {other}"
                    ));
                }
            }
        }

        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let worker_state = Arc::clone(&state);
        let spawn_result = std::thread::Builder::new()
            .name("morphz-secret-backend".to_string())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(callback))
                    .map_err(|_| "Secret Value Backend worker panicked".to_string())
                    .and_then(|result| result);
                let _ = sender.send(result);
                // A timed-out native prompt can still complete after the
                // caller returned. Re-open that backend automatically instead
                // of requiring a process restart after successful approval.
                loop {
                    let current = worker_state.load(Ordering::Acquire);
                    if !matches!(
                        current,
                        BACKEND_OPERATION_IN_FLIGHT | BACKEND_OPERATION_STALLED
                    ) {
                        break;
                    }
                    if worker_state
                        .compare_exchange(
                            current,
                            BACKEND_OPERATION_IDLE,
                            Ordering::AcqRel,
                            Ordering::Acquire,
                        )
                        .is_ok()
                    {
                        break;
                    }
                }
            });
        if let Err(error) = spawn_result {
            let _ = state.compare_exchange(
                BACKEND_OPERATION_IN_FLIGHT,
                BACKEND_OPERATION_IDLE,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
            return Err(format!(
                "Secret Value Backend '{backend_id}' failed to start an isolated worker: {error}"
            ));
        }

        let remaining = operation_timeout
            .checked_sub(started.elapsed())
            .unwrap_or_default();
        match receiver.recv_timeout(remaining) {
            Ok(result) => result,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                let _ = state.compare_exchange(
                    BACKEND_OPERATION_IN_FLIGHT,
                    BACKEND_OPERATION_STALLED,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                );
                Err(format!(
                    "Secret Value Backend '{backend_id}' {operation} operation exceeded {} ms; the call may be waiting for system credential-store authorization, so the Runtime isolated this backend to prevent jobs and shutdown from blocking indefinitely",
                    operation_timeout.as_millis()
                ))
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                let _ = state.compare_exchange(
                    BACKEND_OPERATION_IN_FLIGHT,
                    BACKEND_OPERATION_STALLED,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                );
                Err(format!(
                    "Secret Value Backend '{backend_id}' {operation} worker disconnected unexpectedly; the Runtime has isolated this backend"
                ))
            }
        }
    }

    fn append_usage_audit(
        &self,
        entry: &ManagedSecret,
        usage: SecretUseContext<'_>,
    ) -> Result<(), String> {
        let record = SecretUseAuditRecord {
            name: entry.name.clone(),
            secret_ref: entry.secret_ref.clone(),
            value_backend: entry.value_backend.clone(),
            context_id: usage.context_id.map(ToString::to_string),
            session_id: usage.session_id.map(ToString::to_string),
            objective_id: usage.objective_id.map(ToString::to_string),
            target_id: usage.target_id.map(ToString::to_string),
            used_at: chrono::Utc::now(),
        };
        let _guard = self
            .audit_lock
            .lock()
            .map_err(|_| "Secret usage audit lock is poisoned".to_string())?;
        let parent = self
            .audit_path
            .parent()
            .ok_or("Secret usage audit path has no parent directory")?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.audit_path)
            .map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.audit_path, fs::Permissions::from_mode(0o600))
                .map_err(|error| error.to_string())?;
        }
        serde_json::to_writer(&mut file, &record).map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())?;
        file.flush().map_err(|error| error.to_string())?;
        if file.metadata().map_err(|error| error.to_string())?.len() > MAX_USAGE_AUDIT_BYTES {
            drop(file);
            self.compact_usage_audit()?;
        }
        Ok(())
    }

    fn compact_usage_audit(&self) -> Result<(), String> {
        let contents = fs::read_to_string(&self.audit_path).map_err(|error| error.to_string())?;
        let mut lines = contents
            .lines()
            .rev()
            .take(RETAINED_USAGE_AUDIT_RECORDS)
            .collect::<Vec<_>>();
        lines.reverse();
        let mut compacted = lines.join("\n");
        if !compacted.is_empty() {
            compacted.push('\n');
        }
        atomic_private_write(&self.audit_path, compacted.as_bytes())
    }

    fn persist_catalog<'a>(
        &self,
        entries: impl Iterator<Item = &'a ManagedSecret>,
    ) -> Result<(), String> {
        let values = entries.cloned().collect::<Vec<_>>();
        atomic_private_write(
            &self.catalog_path,
            &serde_json::to_vec_pretty(&values).map_err(|error| error.to_string())?,
        )
    }
}

fn authorize_entry(entry: &ManagedSecret, usage: SecretUseContext<'_>) -> Result<(), String> {
    let actual = match entry.scope_kind {
        SecretScopeKind::Runtime => return Ok(()),
        SecretScopeKind::Context => usage.context_id,
        SecretScopeKind::Session => usage.session_id,
        SecretScopeKind::Objective => usage.objective_id,
        SecretScopeKind::ExecutionTarget => usage.target_id,
    };
    if actual == entry.scope_id.as_deref() {
        Ok(())
    } else {
        Err(format!(
            "managed credential '{}' is not permitted in the current scope",
            entry.secret_ref
        ))
    }
}

fn secret_locator(name: &str) -> String {
    format!("env:{name}")
}

fn locator_name(locator: &str) -> Result<&str, String> {
    locator
        .strip_prefix("env:")
        .ok_or_else(|| format!("Secret locator '{locator}' has an invalid format"))
}

fn env_assignment_name(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let (name, _) = trimmed.split_once('=')?;
    let name = name.trim();
    validate_name(name).is_ok().then_some(name)
}

fn quote_env_value(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn validate_env_file_value(value: &str) -> Result<(), String> {
    validate_value(value)?;
    if value.contains(['\r', '\n']) {
        return Err("Morphz .env backend does not accept multiline credentials".to_string());
    }
    Ok(())
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 128
        || !name.starts_with(|character: char| character.is_ascii_alphabetic() || character == '_')
        || !name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        return Err("credential name must be a valid environment variable name".to_string());
    }
    Ok(())
}

fn validate_value(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("credential must not be empty".to_string());
    }
    if value.contains('\0') {
        return Err("credential must not contain a NUL character".to_string());
    }
    Ok(())
}

fn validate_scope(scope_kind: &SecretScopeKind, scope_id: Option<&str>) -> Result<(), String> {
    match scope_kind {
        SecretScopeKind::Runtime if scope_id.is_some() => {
            Err("Runtime scope must not specify scope_id".to_string())
        }
        SecretScopeKind::Runtime => Ok(()),
        _ if scope_id.is_none_or(str::is_empty) => {
            Err("the selected scope requires scope_id".to_string())
        }
        _ => Ok(()),
    }
}

fn atomic_private_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("credential metadata path has no parent directory")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemorySecretBackend {
        values: Mutex<BTreeMap<String, String>>,
    }

    impl SecretValueBackend for MemorySecretBackend {
        fn backend_id(&self) -> &'static str {
            "memory_test"
        }

        fn storage_kind(&self) -> &'static str {
            "memory"
        }

        fn put(&self, locator: &str, value: &str) -> Result<(), String> {
            self.values
                .lock()
                .map_err(|_| "memory backend poisoned".to_string())?
                .insert(locator.to_string(), value.to_string());
            Ok(())
        }

        fn get(&self, locator: &str) -> Result<Option<String>, String> {
            Ok(self
                .values
                .lock()
                .map_err(|_| "memory backend poisoned".to_string())?
                .get(locator)
                .cloned())
        }

        fn delete(&self, locator: &str) -> Result<bool, String> {
            Ok(self
                .values
                .lock()
                .map_err(|_| "memory backend poisoned".to_string())?
                .remove(locator)
                .is_some())
        }
    }

    fn test_store() -> (tempfile::TempDir, SecretStore) {
        let directory = tempfile::tempdir().unwrap();
        let store = SecretStore::new(
            directory.path().join("managed-secrets.json"),
            Arc::new(MemorySecretBackend::default()),
        )
        .unwrap();
        (directory, store)
    }

    #[test]
    fn native_backend_identifies_the_platform_credential_store() {
        let backend = NativeKeyringSecretBackend;
        #[cfg(target_os = "macos")]
        assert_eq!(backend.backend_id(), "macos_keychain");
        #[cfg(target_os = "windows")]
        assert_eq!(backend.backend_id(), "windows_credential_manager");
        #[cfg(all(
            unix,
            not(any(target_os = "macos", target_os = "ios", target_os = "android"))
        ))]
        assert_eq!(backend.backend_id(), "secret_service");
    }

    #[test]
    fn catalog_never_contains_secret_value() {
        let (directory, store) = test_store();
        store
            .put(
                "DEPLOY_TOKEN",
                "value-that-must-never-be-serialized",
                SecretScopeKind::Runtime,
                None,
            )
            .unwrap();

        let catalog = fs::read_to_string(directory.path().join("managed-secrets.json")).unwrap();
        assert!(!catalog.contains("value-that-must-never-be-serialized"));
        assert!(catalog.contains("DEPLOY_TOKEN"));
        assert_eq!(
            store
                .resolve("DEPLOY_TOKEN", SecretUseContext::default())
                .unwrap()
                .as_deref(),
            Some("value-that-must-never-be-serialized")
        );
    }

    #[test]
    fn scoped_secret_fails_closed_outside_scope() {
        let (_directory, store) = test_store();
        store
            .put(
                "SESSION_TOKEN",
                "sensitive",
                SecretScopeKind::Session,
                Some("session-a".to_string()),
            )
            .unwrap();

        assert!(store
            .resolve(
                "SESSION_TOKEN",
                SecretUseContext {
                    session_id: Some("session-b"),
                    ..Default::default()
                },
            )
            .is_err());
        assert_eq!(
            store
                .resolve(
                    "SESSION_TOKEN",
                    SecretUseContext {
                        session_id: Some("session-a"),
                        ..Default::default()
                    },
                )
                .unwrap()
                .as_deref(),
            Some("sensitive")
        );
    }

    #[test]
    fn deletion_removes_metadata_and_value() {
        let (_directory, store) = test_store();
        store
            .put("SHORT_LIVED", "secret", SecretScopeKind::Runtime, None)
            .unwrap();
        assert!(store.delete("SHORT_LIVED").unwrap());
        assert!(store.list().unwrap().is_empty());
        assert_eq!(
            store
                .resolve("SHORT_LIVED", SecretUseContext::default())
                .unwrap(),
            None
        );
    }

    #[test]
    fn env_file_aliases_are_not_exposed_until_explicitly_imported() {
        let directory = tempfile::tempdir().unwrap();
        let env_path = directory.path().join(".env");
        fs::write(
            &env_path,
            "UNMANAGED_TOKEN=\"must-stay-private\"\n# ignored\nINVALID-NAME=nope\n",
        )
        .unwrap();
        let store = SecretStore::with_backends(
            directory.path().join("managed-secrets.json"),
            "memory_test",
            vec![
                Arc::new(MemorySecretBackend::default()),
                Arc::new(HostEnvFileSecretBackend::new(&env_path)),
            ],
        )
        .unwrap();

        assert!(store.list().unwrap().is_empty());
        assert!(store
            .list_authorized(SecretUseContext::default())
            .unwrap()
            .is_empty());
        assert_eq!(
            store.import_candidates().unwrap(),
            vec![SecretImportCandidate {
                name: "UNMANAGED_TOKEN".to_string(),
                value_backend: "morphz_env_file".to_string(),
            }]
        );

        let imported = store
            .import(
                "UNMANAGED_TOKEN",
                SecretScopeKind::Context,
                Some("context-a".to_string()),
                "morphz_env_file",
            )
            .unwrap();
        assert_eq!(imported.value_backend, "morphz_env_file");
        assert!(store.import_candidates().unwrap().is_empty());
        assert!(store
            .resolve(
                "UNMANAGED_TOKEN",
                SecretUseContext {
                    context_id: Some("context-b"),
                    ..Default::default()
                },
            )
            .is_err());
        assert_eq!(
            store
                .resolve(
                    "UNMANAGED_TOKEN",
                    SecretUseContext {
                        context_id: Some("context-a"),
                        ..Default::default()
                    },
                )
                .unwrap()
                .as_deref(),
            Some("must-stay-private")
        );

        let catalog = fs::read_to_string(directory.path().join("managed-secrets.json")).unwrap();
        assert!(!catalog.contains("must-stay-private"));
    }

    #[test]
    fn explicitly_selected_env_backend_writes_private_file_without_value_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let env_path = directory.path().join(".env");
        let store = SecretStore::with_backends(
            directory.path().join("managed-secrets.json"),
            "memory_test",
            vec![
                Arc::new(MemorySecretBackend::default()),
                Arc::new(HostEnvFileSecretBackend::new(&env_path)),
            ],
        )
        .unwrap();

        store
            .put_with_backend(
                "HEADLESS_TOKEN",
                "quote-\"-and-backslash-\\",
                SecretScopeKind::Runtime,
                None,
                "morphz_env_file",
            )
            .unwrap();

        assert_eq!(
            store
                .resolve("HEADLESS_TOKEN", SecretUseContext::default())
                .unwrap()
                .as_deref(),
            Some("quote-\"-and-backslash-\\")
        );
        let env_contents = fs::read_to_string(&env_path).unwrap();
        assert!(env_contents.contains("HEADLESS_TOKEN="));
        assert!(env_contents.contains("quote-"));
        let catalog = fs::read_to_string(directory.path().join("managed-secrets.json")).unwrap();
        assert!(!catalog.contains("quote-"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&env_path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn usage_audit_records_alias_and_scope_but_never_value() {
        let (directory, store) = test_store();
        store
            .put(
                "AUDITED_TOKEN",
                "audit-value-must-not-leak",
                SecretScopeKind::Session,
                Some("session-a".to_string()),
            )
            .unwrap();
        store
            .resolve(
                "AUDITED_TOKEN",
                SecretUseContext {
                    context_id: Some("context-a"),
                    session_id: Some("session-a"),
                    objective_id: Some("objective-a"),
                    target_id: Some("target-a"),
                },
            )
            .unwrap();

        let audit =
            fs::read_to_string(directory.path().join("managed-secret-usage.jsonl")).unwrap();
        assert!(audit.contains("AUDITED_TOKEN"));
        assert!(audit.contains("session-a"));
        assert!(!audit.contains("audit-value-must-not-leak"));
        assert_eq!(store.recent_usage(10).unwrap().len(), 1);
    }

    #[test]
    fn rotating_to_another_backend_removes_the_previous_backend_value() {
        let directory = tempfile::tempdir().unwrap();
        let original = Arc::new(MemorySecretBackend::default());
        let replacement = Arc::new(MemorySecretBackend::default());
        struct NamedMemoryBackend {
            id: &'static str,
            inner: Arc<MemorySecretBackend>,
        }
        impl SecretValueBackend for NamedMemoryBackend {
            fn backend_id(&self) -> &'static str {
                self.id
            }
            fn storage_kind(&self) -> &'static str {
                "memory"
            }
            fn put(&self, locator: &str, value: &str) -> Result<(), String> {
                self.inner.put(locator, value)
            }
            fn get(&self, locator: &str) -> Result<Option<String>, String> {
                self.inner.get(locator)
            }
            fn delete(&self, locator: &str) -> Result<bool, String> {
                self.inner.delete(locator)
            }
        }
        let store = SecretStore::with_backends(
            directory.path().join("managed-secrets.json"),
            "one",
            vec![
                Arc::new(NamedMemoryBackend {
                    id: "one",
                    inner: original.clone(),
                }),
                Arc::new(NamedMemoryBackend {
                    id: "two",
                    inner: replacement.clone(),
                }),
            ],
        )
        .unwrap();
        store
            .put_with_backend(
                "ROTATING_TOKEN",
                "first",
                SecretScopeKind::Runtime,
                None,
                "one",
            )
            .unwrap();
        store
            .put_with_backend(
                "ROTATING_TOKEN",
                "second",
                SecretScopeKind::Runtime,
                None,
                "two",
            )
            .unwrap();

        assert_eq!(original.get("env:ROTATING_TOKEN").unwrap(), None);
        assert_eq!(
            replacement.get("env:ROTATING_TOKEN").unwrap().as_deref(),
            Some("second")
        );
        assert_eq!(
            store
                .resolve("ROTATING_TOKEN", SecretUseContext::default())
                .unwrap()
                .as_deref(),
            Some("second")
        );
    }

    struct HangingGetBackend {
        get_calls: AtomicUsize,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
    }

    impl SecretValueBackend for HangingGetBackend {
        fn backend_id(&self) -> &'static str {
            "hanging_test"
        }

        fn storage_kind(&self) -> &'static str {
            "test"
        }

        fn put(&self, _locator: &str, _value: &str) -> Result<(), String> {
            Ok(())
        }

        fn get(&self, _locator: &str) -> Result<Option<String>, String> {
            self.get_calls.fetch_add(1, AtomicOrdering::SeqCst);
            self.release
                .lock()
                .map_err(|_| "hanging backend release lock poisoned".to_string())?
                .recv()
                .map_err(|_| "hanging backend release channel closed".to_string())?;
            Ok(Some("eventually-returned".to_string()))
        }

        fn delete(&self, _locator: &str) -> Result<bool, String> {
            Ok(true)
        }
    }

    struct DelayedNativeGetBackend;

    impl SecretValueBackend for DelayedNativeGetBackend {
        fn backend_id(&self) -> &'static str {
            "delayed_native_test"
        }

        fn storage_kind(&self) -> &'static str {
            "native_keyring"
        }

        fn put(&self, _locator: &str, _value: &str) -> Result<(), String> {
            Ok(())
        }

        fn get(&self, _locator: &str) -> Result<Option<String>, String> {
            std::thread::sleep(Duration::from_millis(80));
            Ok(Some("authorized-after-prompt".to_string()))
        }

        fn delete(&self, _locator: &str) -> Result<bool, String> {
            Ok(true)
        }
    }

    #[test]
    fn native_keyring_uses_a_human_authorization_timeout() {
        let directory = tempfile::tempdir().unwrap();
        let store = SecretStore::with_backends_and_timeouts(
            directory.path().join("managed-secrets.json"),
            "delayed_native_test",
            vec![Arc::new(DelayedNativeGetBackend)],
            Duration::from_millis(20),
            Duration::from_millis(200),
        )
        .unwrap();
        store
            .put(
                "PROMPTED_TOKEN",
                "not-persisted",
                SecretScopeKind::Runtime,
                None,
            )
            .unwrap();

        let started = Instant::now();
        assert_eq!(
            store
                .resolve("PROMPTED_TOKEN", SecretUseContext::default())
                .unwrap()
                .as_deref(),
            Some("authorized-after-prompt")
        );
        assert!(started.elapsed() >= Duration::from_millis(80));
    }

    #[test]
    fn stalled_backend_is_bounded_then_recovers_after_the_prompt_completes() {
        let directory = tempfile::tempdir().unwrap();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let backend = Arc::new(HangingGetBackend {
            get_calls: AtomicUsize::new(0),
            release: Mutex::new(release_rx),
        });
        let store = Arc::new(
            SecretStore::with_backends_and_timeout(
                directory.path().join("managed-secrets.json"),
                "hanging_test",
                vec![backend.clone()],
                Duration::from_millis(40),
            )
            .unwrap(),
        );
        store
            .put(
                "BLOCKED_TOKEN",
                "not-persisted",
                SecretScopeKind::Runtime,
                None,
            )
            .unwrap();

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let resolve_store = Arc::clone(&store);
        let started = Instant::now();
        let error = runtime.block_on(async move {
            tokio::task::spawn_blocking(move || {
                resolve_store.resolve("BLOCKED_TOKEN", SecretUseContext::default())
            })
            .await
            .unwrap()
            .unwrap_err()
        });
        assert!(error.contains("exceeded 40 ms"), "{error}");
        assert!(error.contains("isolated this backend"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(1));

        let shutdown_started = Instant::now();
        drop(runtime);
        assert!(
            shutdown_started.elapsed() < Duration::from_secs(1),
            "Tokio shutdown must not join the detached backend worker"
        );

        let retry_started = Instant::now();
        let retry_error = store
            .resolve("BLOCKED_TOKEN", SecretUseContext::default())
            .unwrap_err();
        assert!(retry_error.contains("timed-out operation in progress"));
        assert!(retry_started.elapsed() < Duration::from_millis(20));
        assert_eq!(backend.get_calls.load(AtomicOrdering::SeqCst), 1);

        release_tx.send(()).unwrap();
        let state = store.backend_operation_states.get("hanging_test").unwrap();
        let recovery_deadline = Instant::now() + Duration::from_secs(1);
        while state.load(Ordering::Acquire) != BACKEND_OPERATION_IDLE
            && Instant::now() < recovery_deadline
        {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(state.load(Ordering::Acquire), BACKEND_OPERATION_IDLE);

        release_tx.send(()).unwrap();
        assert_eq!(
            store
                .resolve("BLOCKED_TOKEN", SecretUseContext::default())
                .unwrap()
                .as_deref(),
            Some("eventually-returned")
        );
        assert_eq!(backend.get_calls.load(AtomicOrdering::SeqCst), 2);
    }
}
