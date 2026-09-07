//! Explicit write-through persistence for hosted Runtime files. The directory
//! is a materialization cache, never an alternative durable authority. No hook
//! is installed by ordinary desktop/CLI Runtime startup.
use super::protocol::{Fence, StoreError};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, OnceLock,
};

static HOST_FILES: OnceLock<HostFiles> = OnceLock::new();
const MAX_BYTES: usize = 24 * 1024 * 1024;
pub fn is_active() -> bool {
    HOST_FILES.get().is_some()
}

pub struct HostFiles {
    root: PathBuf,
    tx: mpsc::SyncSender<Operation>,
    lost: Arc<AtomicBool>,
}
enum Operation {
    Write(
        BTreeMap<String, Option<Vec<u8>>>,
        mpsc::SyncSender<Result<(), String>>,
    ),
    DeletePrefix(String, mpsc::SyncSender<Result<(), String>>),
}
#[derive(Clone, Deserialize)]
struct Pointer {
    path: String,
    digest: String,
    bytes: usize,
}
#[derive(Deserialize)]
struct Manifest {
    revision: u64,
    files: Vec<Pointer>,
}
#[derive(Serialize)]
struct Write {
    path: String,
    content: Option<String>,
}
struct Io {
    root: PathBuf,
    endpoint: reqwest::Url,
    client: reqwest::blocking::Client,
    token: reqwest::header::HeaderValue,
    fence: String,
    lost: Arc<AtomicBool>,
}
fn relative(root: &Path, path: &Path) -> Result<String, String> {
    let path = path
        .strip_prefix(root)
        .map_err(|_| "host file is outside the materialization root")?;
    if path
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
        || path.as_os_str().is_empty()
    {
        return Err("invalid hosted file path".into());
    }
    let key = path.to_str().ok_or("hosted file path is not UTF-8")?;
    if matches!(
        key.split('/')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        ".env"
            | "morphz.toml"
            | "models.toml"
            | "config.toml"
            | "managed.toml"
            | "managed-secrets.json"
            | "managed-secret-usage.jsonl"
    ) {
        return Err("host configuration and credentials require the database authority".into());
    }
    if key.len() > 1024
        || key.contains('\\')
        || key.chars().any(char::is_control)
        || key
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("invalid hosted file path".into());
    }
    Ok(key.to_owned())
}
fn canonical(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let sorted: BTreeMap<_, _> = map
                .into_iter()
                .map(|(key, value)| (key, canonical(value)))
                .collect();
            serde_json::to_value(sorted).expect("JSON object")
        }
        Value::Array(values) => Value::Array(values.into_iter().map(canonical).collect()),
        other => other,
    }
}
impl Io {
    fn request(
        &self,
        method: reqwest::Method,
        query: &[(&str, &str)],
        body: Option<Vec<u8>>,
    ) -> Result<Vec<u8>, String> {
        if self.lost.load(Ordering::Acquire) {
            return Err("host file ownership lost".into());
        }
        let mut request = self
            .client
            .request(method, self.endpoint.clone())
            .query(query)
            .header(reqwest::header::AUTHORIZATION, self.token.clone())
            .header("x-morphz-compute-fence", &self.fence);
        if let Some(body) = body {
            request = request
                .header("content-type", "application/json")
                .body(body);
        }
        let response = request
            .send()
            .map_err(|_| "host file authority unavailable")?;
        if !response.status().is_success() {
            return Err(format!(
                "host file authority rejected request ({})",
                response.status().as_u16()
            ));
        }
        use std::io::Read;
        let mut bytes = Vec::new();
        response
            .take((MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "host file response interrupted")?;
        if bytes.len() > MAX_BYTES || self.lost.load(Ordering::Acquire) {
            return Err("host file capacity or ownership check failed".into());
        }
        Ok(bytes)
    }
    fn manifest(&self) -> Result<(u64, BTreeMap<String, Pointer>), String> {
        let mut after = String::new();
        let mut revision = None;
        let mut files = BTreeMap::new();
        loop {
            let page: Manifest = serde_json::from_slice(&self.request(
                reqwest::Method::GET,
                &[("after", &after)],
                None,
            )?)
            .map_err(|_| "invalid host file manifest")?;
            if revision.is_some_and(|revision| revision != page.revision) {
                return Err("host file snapshot changed".into());
            }
            revision = Some(page.revision);
            let count = page.files.len();
            for pointer in page.files {
                let path = self.root.join(&pointer.path);
                if relative(&self.root, &path)? != pointer.path
                    || pointer.path <= after
                    || pointer.bytes > MAX_BYTES
                {
                    return Err("invalid host file manifest path".into());
                }
                after = pointer.path.clone();
                files.insert(pointer.path.clone(), pointer);
            }
            if count < 100 {
                return Ok((page.revision, files));
            }
        }
    }
    fn restore(&self) -> Result<(), String> {
        let (revision, files) = self.manifest()?;
        for pointer in files.values() {
            let bytes = self.request(reqwest::Method::GET, &[("path", &pointer.path)], None)?;
            if bytes.len() != pointer.bytes
                || format!("{:x}", Sha256::digest(&bytes)) != pointer.digest
            {
                return Err("host file integrity failure".into());
            }
            let path = self.root.join(&pointer.path);
            std::fs::create_dir_all(path.parent().ok_or("invalid host file parent")?)
                .map_err(|e| e.to_string())?;
            std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                    .map_err(|e| e.to_string())?;
            }
        }
        if self.manifest()?.0 != revision {
            return Err("host files changed during restore".into());
        }
        Ok(())
    }
    fn commit(&self, changes: BTreeMap<String, Option<Vec<u8>>>) -> Result<(), String> {
        let (revision, files) = self.manifest()?;
        let mut writes = Vec::new();
        for (path, bytes) in changes {
            if let Some(bytes) = &bytes {
                if bytes.len() > MAX_BYTES {
                    return Err("host file capacity exceeded".into());
                }
                if files
                    .get(&path)
                    .is_some_and(|pointer| pointer.digest == format!("{:x}", Sha256::digest(bytes)))
                {
                    continue;
                }
            } else if !files.contains_key(&path) {
                continue;
            }
            writes.push(Write {
                path,
                content: bytes.as_ref().map(|bytes| STANDARD.encode(bytes)),
            });
        }
        if writes.is_empty() {
            return Ok(());
        }
        if writes.len() > 100 {
            return Err("host file atomic operation exceeds 100 files".into());
        }
        let content = canonical(json!({"revision": revision, "files": writes}));
        let id = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&content).map_err(|e| e.to_string())?)
        );
        let mut body = content;
        body["requestId"] = json!(id);
        let bytes = serde_json::to_vec(&body).map_err(|e| e.to_string())?;
        if bytes.len() > 34 * 1024 * 1024 {
            return Err("host file atomic operation exceeds capacity".into());
        }
        // On an ambiguous outcome the host fails closed; a fresh process
        // reconstructs the acknowledged pointer set rather than trusting cache.
        let receipt: Value =
            serde_json::from_slice(&self.request(reqwest::Method::POST, &[], Some(bytes))?)
                .map_err(|_| "invalid host file receipt")?;
        if receipt.get("revision").and_then(Value::as_u64) != revision.checked_add(1) {
            return Err("host file receipt revision mismatch".into());
        }
        Ok(())
    }
    fn delete_prefix(&self, prefix: &str) -> Result<(), String> {
        let (_, existing) = self.manifest()?;
        // Only already-published object pointers are removed. Never enumerate
        // or upload the contents of a local directory or Agent workspace.
        let changes = existing
            .keys()
            .filter(|key| key.as_str() == prefix || key.starts_with(&format!("{prefix}/")))
            .map(|key| (key.clone(), None))
            .collect();
        self.commit(changes)
    }
}
impl HostFiles {
    /// Cache root must be an empty, operator-created directory. This constructor
    /// does not erase/reuse a user's existing Morphz HOME or other local data.
    pub fn restore(
        root: PathBuf,
        endpoint: &str,
        token: &str,
        fence: Fence,
        lost: Arc<AtomicBool>,
    ) -> Result<Self, StoreError> {
        if !root.is_absolute()
            || std::fs::symlink_metadata(&root)?.file_type().is_symlink()
            || std::fs::read_dir(&root)?.next().is_some()
        {
            return Err("remote host requires an empty dedicated cache directory".into());
        }
        let endpoint = reqwest::Url::parse(endpoint)?;
        if !matches!(endpoint.scheme(), "https" | "http")
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.fragment().is_some()
        {
            return Err("invalid private host file endpoint".into());
        }
        if token.trim().is_empty() {
            return Err("host file credential is required".into());
        }
        let mut token = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))?;
        token.set_sensitive(true);
        let fence = serde_json::to_string(&fence)?;
        let (tx, rx) = mpsc::sync_channel(4);
        let (ready, initialized) = mpsc::sync_channel(1);
        let io_root = root.clone();
        let worker_lost = lost.clone();
        std::thread::Builder::new()
            .name("morphz-host-file-io".into())
            .spawn(move || {
                let initialize = || -> Result<Io, String> {
                    let client = reqwest::blocking::Client::builder()
                        .redirect(reqwest::redirect::Policy::none())
                        .connect_timeout(std::time::Duration::from_secs(5))
                        .timeout(std::time::Duration::from_secs(30))
                        .build()
                        .map_err(|_| "host file client initialization failed")?;
                    let io = Io {
                        root: io_root,
                        endpoint,
                        client,
                        token,
                        fence,
                        lost: worker_lost,
                    };
                    io.restore()?;
                    Ok(io)
                };
                let io = match initialize() {
                    Ok(io) => {
                        let _ = ready.send(Ok(()));
                        io
                    }
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return;
                    }
                };
                for operation in rx {
                    let (result, reply) = match operation {
                        Operation::Write(changes, reply) => (io.commit(changes), reply),
                        Operation::DeletePrefix(prefix, reply) => {
                            (io.delete_prefix(&prefix), reply)
                        }
                    };
                    if result.is_err() {
                        io.lost.store(true, Ordering::Release);
                    }
                    let _ = reply.send(result);
                }
            })?;
        initialized
            .recv()
            .map_err(|_| "host file worker stopped")??;
        Ok(Self { root, tx, lost })
    }
    pub fn install(self) -> Result<(), StoreError> {
        HOST_FILES
            .set(self)
            .map_err(|_| "host file backend already installed".into())
    }
}
/// Write-through hook: callers update their cache only after this succeeds.
pub fn publish(path: &Path, bytes: Option<&[u8]>) -> Result<(), String> {
    publish_batch(vec![(path.to_path_buf(), bytes.map(<[u8]>::to_vec))])
}
/// Explicit bytes only: callers must supply the uploaded/generated data. This
/// API deliberately cannot scan a directory or read arbitrary workspace files.
pub fn publish_batch(changes: Vec<(PathBuf, Option<Vec<u8>>)>) -> Result<(), String> {
    let Some(files) = HOST_FILES.get() else {
        return Ok(());
    };
    files.publish(changes)
}
impl HostFiles {
    pub fn publish(&self, changes: Vec<(PathBuf, Option<Vec<u8>>)>) -> Result<(), String> {
        with_blocking_io(|| self.publish_blocking(changes))
    }

    fn publish_blocking(&self, changes: Vec<(PathBuf, Option<Vec<u8>>)>) -> Result<(), String> {
        if self.lost.load(Ordering::Acquire) {
            return Err("host file ownership lost".into());
        }
        let mut writes = BTreeMap::new();
        for (path, bytes) in changes {
            let key = relative(&self.root, &path)?;
            if let Some(existing) = writes.get(&key) {
                if existing != &bytes {
                    return Err("conflicting hosted file path".into());
                }
            } else {
                writes.insert(key, bytes);
            }
        }
        let (tx, rx) = mpsc::sync_channel(1);
        self.tx
            .send(Operation::Write(writes, tx))
            .map_err(|_| "host file worker stopped")?;
        rx.recv().map_err(|_| "host file worker stopped")?
    }
}
pub fn delete_prefix(path: &Path) -> Result<(), String> {
    let Some(files) = HOST_FILES.get() else {
        return Ok(());
    };
    with_blocking_io(|| {
        let key = relative(&files.root, path)?;
        let (tx, rx) = mpsc::sync_channel(1);
        files
            .tx
            .send(Operation::DeletePrefix(key, tx))
            .map_err(|_| "host file worker stopped")?;
        rx.recv().map_err(|_| "host file worker stopped")?
    })
}

fn with_blocking_io<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            // Hand the scheduler worker back even on a single-vCPU host. The
            // independent lease task must run while synchronous config/file
            // callers await the dedicated I/O thread or a full bounded queue.
            tokio::task::block_in_place(operation)
        }
        Ok(_) => Err(
            "hosted file persistence requires a multi-thread Tokio runtime or a blocking worker"
                .into(),
        ),
        Err(_) => operation(),
    }
}
/// A local cache failure after remote acknowledgement must not leave a running
/// process with different configuration/files than the durable authority.
pub fn invalidate_cache() {
    if let Some(files) = HOST_FILES.get() {
        files.lost.store(true, Ordering::Release);
    }
}

/// Acknowledged remote writes must not leave a running process with a failed
/// local materialization. This guard adds no network or persistence operation.
#[derive(Default)]
pub struct CacheUpdate {
    complete: bool,
}
impl CacheUpdate {
    pub fn complete(&mut self) {
        self.complete = true;
    }
}
impl Drop for CacheUpdate {
    fn drop(&mut self) {
        if !self.complete {
            invalidate_cache();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uploaded_file_keys_cannot_escape_the_cache_or_alias_paths() {
        let root = Path::new("/cache");
        assert_eq!(
            relative(root, Path::new("/cache/attachments/event/测试.pdf")).unwrap(),
            "attachments/event/测试.pdf"
        );
        for path in [
            "/etc/hosts",
            "/cache-other/file",
            "/cache",
            "/cache/../secret",
            "/cache/a/./b",
            "/cache/a//b",
            "/cache/a\\b",
            "/cache/a\nfile",
            "/cache/.env",
            "/cache/.ENV",
            "/cache/models.toml",
            "/cache/managed-secrets.json",
            "/cache/managed-secret-usage.jsonl",
        ] {
            assert!(
                relative(root, Path::new(path)).is_err(),
                "accepted {path:?}"
            );
        }
    }

    #[test]
    fn canonical_commits_sort_nested_keys_and_preserve_upload_bytes() {
        let value =
            canonical(json!({"revision": 4, "files": [{"path":"上传.pdf", "content": "AAEC"}]}));
        assert_eq!(
            serde_json::to_string(&value).unwrap(),
            r#"{"files":[{"content":"AAEC","path":"上传.pdf"}],"revision":4}"#
        );
    }

    #[test]
    fn host_never_replaces_nonempty_operator_directory() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("preserve");
        std::fs::write(&file, b"synthetic data").unwrap();
        let result = HostFiles::restore(
            directory.path().to_path_buf(),
            "http://127.0.0.1:1",
            "test-only",
            Fence {
                owner_id: "test".into(),
                epoch: 1,
            },
            Arc::new(AtomicBool::new(false)),
        );
        assert!(result.is_err());
        assert_eq!(std::fs::read(file).unwrap(), b"synthetic data");
    }
}
