//! Runtime-managed secret references.
//!
//! Metadata is safe to inspect and is stored separately from secret values.
//! Values live behind a pluggable [`SecretValueBackend`]. The default backend
//! uses the operating-system credential store through `keyring`; it never
//! falls back to a plaintext file.

use crate::config::morphz_home_dir;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

const NATIVE_KEYRING_SERVICE: &str = "ai.morphz.runtime.secrets.v1";

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
    fn put(&self, locator: &str, value: &str) -> Result<(), String>;
    fn get(&self, locator: &str) -> Result<Option<String>, String>;
    fn delete(&self, locator: &str) -> Result<bool, String>;
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
            .map_err(|error| native_backend_error("打开", error))
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

    fn put(&self, locator: &str, value: &str) -> Result<(), String> {
        Self::entry(locator)?
            .set_password(value)
            .map_err(|error| native_backend_error("写入", error))
    }

    fn get(&self, locator: &str) -> Result<Option<String>, String> {
        match Self::entry(locator)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(native_backend_error("读取", error)),
        }
    }

    fn delete(&self, locator: &str) -> Result<bool, String> {
        match Self::entry(locator)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(error) => Err(native_backend_error("删除", error)),
        }
    }
}

fn native_backend_error(operation: &str, error: keyring::Error) -> String {
    format!(
        "无法{operation}系统凭证库：{error}。macOS 需要可访问的 Keychain，Windows 需要 Credential Manager，Linux 需要可用的 Secret Service/D-Bus；Morphz 不会退回明文文件"
    )
}

/// Metadata catalog plus one value backend. One Runtime owns one store.
pub struct SecretStore {
    catalog_path: PathBuf,
    backend: Arc<dyn SecretValueBackend>,
    catalog: RwLock<BTreeMap<String, ManagedSecret>>,
}

impl std::fmt::Debug for SecretStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SecretStore")
            .field("catalog_path", &self.catalog_path)
            .field("backend", &self.backend.backend_id())
            .finish_non_exhaustive()
    }
}

impl SecretStore {
    pub fn native_default() -> Result<Self, String> {
        let catalog_path = morphz_home_dir()
            .map(|path| path.join("managed-secrets.json"))
            .ok_or_else(|| "无法确定 Morphz 用户配置目录".to_string())?;
        Self::new(catalog_path, Arc::new(NativeKeyringSecretBackend))
    }

    pub fn new(
        catalog_path: impl Into<PathBuf>,
        backend: Arc<dyn SecretValueBackend>,
    ) -> Result<Self, String> {
        let catalog_path = catalog_path.into();
        let entries = match fs::read(&catalog_path) {
            Ok(bytes) => serde_json::from_slice::<Vec<ManagedSecret>>(&bytes)
                .map_err(|error| format!("Secret metadata catalog 无法解析：{error}"))?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(format!("Secret metadata catalog 无法读取：{error}")),
        };
        let catalog = entries
            .into_iter()
            .map(|entry| (entry.name.clone(), entry))
            .collect();
        Ok(Self {
            catalog_path,
            backend,
            catalog: RwLock::new(catalog),
        })
    }

    pub fn backend_id(&self) -> &'static str {
        self.backend.backend_id()
    }

    pub fn list(&self) -> Result<Vec<ManagedSecret>, String> {
        Ok(self
            .catalog
            .read()
            .map_err(|_| "Secret metadata catalog 锁已损坏".to_string())?
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
            .map_err(|_| "Secret metadata catalog 锁已损坏".to_string())?
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
        validate_name(name)?;
        validate_value(value)?;
        validate_scope(&scope_kind, scope_id.as_deref())?;

        let locator = secret_locator(name);
        // Persist the value first. The catalog never contains the value and a
        // catalog failure can at worst leave an unreachable native credential.
        self.backend.put(&locator, value)?;

        let now = chrono::Utc::now();
        let mut guard = self
            .catalog
            .write()
            .map_err(|_| "Secret metadata catalog 锁已损坏".to_string())?;
        let created_at = guard.get(name).map(|entry| entry.created_at).unwrap_or(now);
        let entry = ManagedSecret {
            name: name.to_string(),
            secret_ref: format!("secret://runtime/{name}"),
            scope_kind,
            scope_id,
            value_backend: self.backend.backend_id().to_string(),
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
            .map_err(|_| "Secret metadata catalog 锁已损坏".to_string())?;
        if !guard.contains_key(name) {
            return Ok(false);
        }
        self.backend.delete(&secret_locator(name))?;
        let mut next = guard.clone();
        next.remove(name);
        self.persist_catalog(next.values())?;
        *guard = next;
        Ok(true)
    }

    /// Resolve one approved alias. Managed aliases use the configured secure
    /// backend; unregistered process environment variables remain supported
    /// for bootstrap and backwards compatibility.
    pub fn resolve(
        &self,
        name: &str,
        usage: SecretUseContext<'_>,
    ) -> Result<Option<String>, String> {
        validate_name(name)?;
        let entry = self
            .catalog
            .read()
            .map_err(|_| "Secret metadata catalog 锁已损坏".to_string())?
            .get(name)
            .cloned();
        let Some(entry) = entry else {
            return std::env::var(name).map(Some).or_else(|error| match error {
                std::env::VarError::NotPresent => Ok(None),
                std::env::VarError::NotUnicode(_) => {
                    Err(format!("环境变量 '{name}' 不是有效 Unicode"))
                }
            });
        };
        authorize_entry(&entry, usage)?;
        let value = self.backend.get(&secret_locator(name))?.ok_or_else(|| {
            format!(
                "受管凭证 '{}' 的元数据存在，但系统凭证库中没有对应值",
                entry.secret_ref
            )
        })?;
        if value.is_empty() {
            return Err(format!("受管凭证 '{}' 的值为空", entry.secret_ref));
        }
        Ok(Some(value))
    }

    pub fn contains_alias(&self, name: &str) -> Result<bool, String> {
        validate_name(name)?;
        if self
            .catalog
            .read()
            .map_err(|_| "Secret metadata catalog 锁已损坏".to_string())?
            .contains_key(name)
        {
            return Ok(true);
        }
        Ok(std::env::var_os(name).is_some())
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
            "受管凭证 '{}' 不允许在当前作用域使用",
            entry.secret_ref
        ))
    }
}

fn secret_locator(name: &str) -> String {
    format!("env:{name}")
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 128
        || !name.starts_with(|character: char| character.is_ascii_alphabetic() || character == '_')
        || !name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        return Err("凭证名称必须是合法的环境变量名".to_string());
    }
    Ok(())
}

fn validate_value(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("凭证不能为空".to_string());
    }
    if value.contains('\0') {
        return Err("凭证不能包含 NUL 字符".to_string());
    }
    Ok(())
}

fn validate_scope(scope_kind: &SecretScopeKind, scope_id: Option<&str>) -> Result<(), String> {
    match scope_kind {
        SecretScopeKind::Runtime if scope_id.is_some() => {
            Err("Runtime 作用域不能指定 scope_id".to_string())
        }
        SecretScopeKind::Runtime => Ok(()),
        _ if scope_id.is_none_or(str::is_empty) => Err("所选作用域必须指定 scope_id".to_string()),
        _ => Ok(()),
    }
}

fn atomic_private_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("凭证元数据路径没有父目录")?;
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
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemorySecretBackend {
        values: Mutex<BTreeMap<String, String>>,
    }

    impl SecretValueBackend for MemorySecretBackend {
        fn backend_id(&self) -> &'static str {
            "memory_test"
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
}
