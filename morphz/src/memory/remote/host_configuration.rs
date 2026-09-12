//! Database-backed primary configuration. TOML on disk is a disposable parser
//! cache; only the two named configuration documents are remotely persisted.
use super::{http::HttpRemoteStoreTransport, protocol::Fence};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, OnceLock,
};
use std::time::Duration;

static CONFIGURATION: OnceLock<HostConfiguration> = OnceLock::new();
pub struct HostConfiguration {
    root: PathBuf,
    tx: mpsc::SyncSender<Write>,
}
struct Write {
    name: &'static str,
    content: String,
    reply: mpsc::SyncSender<Result<(), String>>,
}
struct Io {
    client: reqwest::blocking::Client,
    endpoint: reqwest::Url,
    token: reqwest::header::HeaderValue,
    fence: Fence,
    lost: Arc<AtomicBool>,
    revisions: BTreeMap<&'static str, u64>,
}
impl Io {
    fn request(&self, mut body: Value) -> Result<Value, String> {
        if self.lost.load(Ordering::Acquire) {
            return Err("configuration ownership lost".into());
        }
        body["protocol"] = json!("morphz-host-configuration/1");
        body["fence"] = json!(self.fence);
        let response = self
            .client
            .post(self.endpoint.clone())
            .header(reqwest::header::AUTHORIZATION, self.token.clone())
            .json(&body)
            .send()
            .map_err(|_| "configuration authority unavailable")?;
        if !response.status().is_success() {
            return Err(format!(
                "configuration authority rejected request ({})",
                response.status().as_u16()
            ));
        }
        let mut bytes = zeroize::Zeroizing::new(Vec::new());
        response
            .take(512 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "configuration response interrupted")?;
        if bytes.len() > 512 * 1024 || self.lost.load(Ordering::Acquire) {
            return Err("configuration capacity or ownership check failed".into());
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| "invalid configuration authority response".into())
    }
    fn write(&mut self, name: &str, content: String) -> Result<(), String> {
        let revision = *self
            .revisions
            .get(name)
            .ok_or("unknown configuration document")?;
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(|_| "configuration request identity unavailable")?;
        let request_id: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
        let response = self.request(json!({"operation":"write", "name":name, "content":content, "expectedRevision":revision, "requestId":request_id}))?;
        let next = response["revision"]
            .as_u64()
            .ok_or("invalid configuration revision")?;
        if Some(next) != revision.checked_add(1) {
            return Err("configuration publication receipt mismatch".into());
        }
        *self
            .revisions
            .get_mut(name)
            .ok_or("unknown configuration document")? = next;
        Ok(())
    }
}
impl HostConfiguration {
    pub fn restore(
        root: PathBuf,
        endpoint: &str,
        token: &str,
        fence: Fence,
        lost: Arc<AtomicBool>,
        private: bool,
    ) -> Result<Self, String> {
        if private {
            HttpRemoteStoreTransport::private_gateway(endpoint, token)
        } else {
            HttpRemoteStoreTransport::new(endpoint, token)
        }
        .map_err(|_| "invalid configuration authority transport")?;
        let endpoint =
            reqwest::Url::parse(endpoint).map_err(|_| "invalid configuration endpoint")?;
        let mut token = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| "invalid configuration authority token")?;
        token.set_sensitive(true);
        let (tx, rx) = mpsc::sync_channel::<Write>(4);
        let (ready, initialized) = mpsc::sync_channel(1);
        let cache = root.clone();
        std::thread::Builder::new()
            .name("morphz-host-config-io".into())
            .spawn(move || {
                let initialize = || -> Result<Io, String> {
                    let client = reqwest::blocking::Client::builder()
                        .redirect(reqwest::redirect::Policy::none())
                        .connect_timeout(Duration::from_secs(3))
                        .timeout(Duration::from_secs(10))
                        .build()
                        .map_err(|_| "configuration client unavailable")?;
                    let mut io = Io {
                        client,
                        endpoint,
                        token,
                        fence,
                        lost,
                        revisions: BTreeMap::new(),
                    };
                    for name in ["morphz", "models"] {
                        let path = cache.join(format!("{name}.toml"));
                        if path.exists() {
                            return Err(
                                "configuration cache must not have an alternate authority".into()
                            );
                        }
                        let response = io.request(json!({"operation":"read", "name":name}))?;
                        io.revisions.insert(
                            name,
                            response["revision"]
                                .as_u64()
                                .ok_or("invalid configuration revision")?,
                        );
                        if !response["content"].is_null() {
                            let content = response["content"]
                                .as_str()
                                .ok_or("invalid configuration document")?;
                            std::fs::write(&path, content)
                                .map_err(|_| "configuration cache write failed")?;
                            #[cfg(unix)]
                            {
                                use std::os::unix::fs::PermissionsExt;
                                std::fs::set_permissions(
                                    &path,
                                    std::fs::Permissions::from_mode(0o600),
                                )
                                .map_err(|_| "configuration cache permissions failed")?;
                            }
                        }
                    }
                    Ok(io)
                };
                let mut io = match initialize() {
                    Ok(io) => {
                        let _ = ready.send(Ok(()));
                        io
                    }
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return;
                    }
                };
                for write in rx {
                    let result = io.write(write.name, write.content);
                    if result.is_err() {
                        io.lost.store(true, Ordering::Release);
                    }
                    let _ = write.reply.send(result);
                }
            })
            .map_err(|_| "configuration worker unavailable")?;
        initialized
            .recv()
            .map_err(|_| "configuration worker stopped")??;
        Ok(Self { root, tx })
    }
    pub fn install(self) -> Result<(), String> {
        CONFIGURATION
            .set(self)
            .map_err(|_| "configuration authority already installed".into())
    }
}
pub fn publish(path: &Path, content: &str) -> Result<(), String> {
    let Some(configuration) = CONFIGURATION.get() else {
        return Ok(());
    };
    let name = if path == configuration.root.join("morphz.toml") {
        "morphz"
    } else if path == configuration.root.join("models.toml") {
        "models"
    } else {
        return Err("configuration write is outside the primary documents".into());
    };
    let operation = || {
        let (reply, result) = mpsc::sync_channel(1);
        configuration
            .tx
            .send(Write {
                name,
                content: content.to_owned(),
                reply,
            })
            .map_err(|_| "configuration worker stopped")?;
        result.recv().map_err(|_| "configuration worker stopped")?
    };
    match tokio::runtime::Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(operation)
        }
        Ok(_) => {
            Err("hosted configuration requires a blocking worker or multi-thread Runtime".into())
        }
        Err(_) => operation(),
    }
}
