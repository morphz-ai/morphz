//! Cloud credential authority: no plaintext file or local catalog mirror.
//! Root encryption keys stay in the trusted Worker; this client only carries
//! its per-Agent service token and current compute fence.
use super::{http::HttpRemoteStoreTransport, protocol::Fence};
use crate::secret_store::{
    ManagedSecret, SecretUseAuditRecord, SecretValueBackend, VersionedSecretValue,
};
use reqwest::header::{HeaderValue, AUTHORIZATION};
use serde_json::{json, Value};
use std::io::Read;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

const GENERATION_CONFLICT: &str = "credential authority logical generation changed";

pub struct HostCredentialBackend {
    endpoint: reqwest::Url,
    token: HeaderValue,
    fence: Fence,
    lost: Arc<AtomicBool>,
}
impl HostCredentialBackend {
    pub fn new(
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
        .map_err(|_| "invalid private credential authority transport")?;
        let mut token = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| "invalid credential authority token")?;
        token.set_sensitive(true);
        Ok(Self {
            endpoint: reqwest::Url::parse(endpoint)
                .map_err(|_| "invalid credential authority endpoint")?,
            token,
            fence,
            lost,
        })
    }
    fn request(&self, mut body: Value) -> Result<Value, String> {
        if self.lost.load(Ordering::Acquire) {
            return Err("credential authority ownership lost".into());
        }
        body["protocol"] = json!("morphz-host-credentials/1");
        body["fence"] = json!(self.fence);
        // SecretStore runs backend operations on blocking workers. Construct
        // and drop reqwest's blocking runtime there, never on a Tokio worker.
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| "credential authority client unavailable")?;
        let result = (|| {
            let response = client
                .post(self.endpoint.clone())
                .header(AUTHORIZATION, self.token.clone())
                .json(&body)
                .send()
                .map_err(|_| "credential authority unavailable")?;
            let status = response.status();
            let mut bytes = zeroize::Zeroizing::new(Vec::new());
            response
                .take(2 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "credential authority response interrupted")?;
            if bytes.len() > 2 * 1024 * 1024 {
                return Err("credential authority response too large".into());
            }
            if !status.is_success() {
                if status.as_u16() == 409
                    && serde_json::from_slice::<Value>(&bytes)
                        .is_ok_and(|body| body["error"] == "credential_generation_conflict")
                {
                    return Err(GENERATION_CONFLICT.into());
                }
                return Err(format!(
                    "credential authority rejected request ({})",
                    status.as_u16()
                ));
            }
            if self.lost.load(Ordering::Acquire) {
                return Err("credential authority ownership lost".into());
            }
            serde_json::from_slice(&bytes)
                .map_err(|_| "invalid credential authority response".into())
        })();
        // An ambiguous write must never leave this process serving an outdated
        // catalog. The host exits; its successor loads the committed authority.
        if result
            .as_ref()
            .is_err_and(|error| error != GENERATION_CONFLICT)
        {
            self.lost.store(true, Ordering::Release);
        }
        result
    }
    fn name(locator: &str) -> Result<&str, String> {
        locator
            .strip_prefix("env:")
            .filter(|name| !name.is_empty())
            .ok_or_else(|| "invalid hosted credential locator".into())
    }
    fn head(&self, name: &str) -> Result<(u64, bool), String> {
        let head = self.request(json!({"operation":"head", "name":name}))?;
        Ok((
            head["revision"]
                .as_u64()
                .ok_or("invalid credential revision")?,
            head["present"]
                .as_bool()
                .ok_or("invalid credential presence")?,
        ))
    }
    fn request_id() -> Result<String, String> {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| "credential request identity unavailable")?;
        Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }
    fn read(&self, name: &str, usage: Value) -> Result<Option<String>, String> {
        let value = self.request(json!({"operation":"read", "name":name, "usage":usage}))?;
        if value["value"].is_null() {
            return Ok(None);
        }
        value["value"]
            .as_str()
            .map(|value| Some(value.to_owned()))
            .ok_or_else(|| "invalid resolved credential".into())
    }
}
impl SecretValueBackend for HostCredentialBackend {
    fn backend_id(&self) -> &'static str {
        "cloud_agent_cell"
    }
    fn storage_kind(&self) -> &'static str {
        "encrypted_agent_database"
    }
    fn status_detail(&self) -> String {
        "Cloudflare Worker encryption; fenced Agent Cell database with atomic metadata and audit"
            .into()
    }
    fn manages_metadata(&self) -> bool {
        true
    }
    fn put(&self, _locator: &str, _value: &str) -> Result<(), String> {
        Err("hosted credentials require atomic managed metadata".into())
    }
    fn put_managed(&self, entry: &ManagedSecret, value: &str) -> Result<(), String> {
        let (revision, _) = self.head(&entry.name)?;
        let receipt = self.request(
            json!({"operation":"write", "name":entry.name, "value":value, "metadata":entry,
            "expectedRevision":revision, "requestId":Self::request_id()?}),
        )?;
        if receipt["revision"].as_u64() != revision.checked_add(1) || receipt["present"] != true {
            self.lost.store(true, Ordering::Release);
            return Err("credential publication receipt mismatch".into());
        }
        Ok(())
    }
    fn put_managed_if_version(
        &self,
        entry: &ManagedSecret,
        value: &str,
        version: Option<u64>,
    ) -> Result<bool, String> {
        let generation =
            version.ok_or("hosted conditional credential update requires a captured version")?;
        let receipt = match self.request(json!({"operation":"replace", "name":entry.name,
            "value":value, "metadata":entry, "expectedGeneration":generation, "requestId":Self::request_id()?})) {
            Ok(receipt) => receipt,
            Err(error) if error == GENERATION_CONFLICT => return Ok(false),
            Err(error) => return Err(error),
        };
        if !receipt["revision"]
            .as_u64()
            .is_some_and(|revision| revision > generation)
            || receipt["present"] != true
        {
            self.lost.store(true, Ordering::Release);
            return Err("conditional credential publication receipt mismatch".into());
        }
        Ok(true)
    }
    fn get(&self, locator: &str) -> Result<Option<String>, String> {
        self.read(Self::name(locator)?, json!({}))
    }
    fn get_managed(
        &self,
        entry: &ManagedSecret,
        audit: &SecretUseAuditRecord,
    ) -> Result<Option<String>, String> {
        let mut usage = serde_json::Map::new();
        for (name, value) in [
            ("context_id", &audit.context_id),
            ("session_id", &audit.session_id),
            ("objective_id", &audit.objective_id),
            ("target_id", &audit.target_id),
        ] {
            if let Some(value) = value {
                usage.insert(name.into(), json!(value));
            }
        }
        self.read(&entry.name, Value::Object(usage))
    }
    fn get_managed_versioned(
        &self,
        entry: &ManagedSecret,
        audit: &SecretUseAuditRecord,
    ) -> Result<VersionedSecretValue, String> {
        let mut usage = serde_json::Map::new();
        for (name, value) in [
            ("context_id", &audit.context_id),
            ("session_id", &audit.session_id),
            ("objective_id", &audit.objective_id),
            ("target_id", &audit.target_id),
        ] {
            if let Some(value) = value {
                usage.insert(name.into(), json!(value));
            }
        }
        let response =
            self.request(json!({"operation":"read-versioned", "name":entry.name, "usage":usage}))?;
        let version = response["generation"]
            .as_u64()
            .ok_or("credential authority omitted its logical generation")?;
        let value = if response["value"].is_null() {
            None
        } else {
            Some(
                response["value"]
                    .as_str()
                    .ok_or("invalid versioned credential value")?
                    .to_string(),
            )
        };
        Ok(VersionedSecretValue {
            value,
            version: Some(version),
        })
    }
    fn delete(&self, locator: &str) -> Result<bool, String> {
        let name = Self::name(locator)?;
        let (revision, present) = self.head(name)?;
        if !present {
            return Ok(false);
        }
        let receipt = self.request(json!({"operation":"delete", "name":name, "expectedRevision":revision, "requestId":Self::request_id()?}))?;
        if receipt["revision"].as_u64() != revision.checked_add(1) || receipt["present"] != false {
            self.lost.store(true, Ordering::Release);
            return Err("credential deletion receipt mismatch".into());
        }
        Ok(true)
    }
    fn load_metadata(&self) -> Result<Vec<ManagedSecret>, String> {
        let mut after = String::new();
        let mut all = Vec::new();
        loop {
            let value = self.request(json!({"operation":"catalog", "afterName":after}))?;
            let entries: Vec<ManagedSecret> = serde_json::from_value(value["entries"].clone())
                .map_err(|_| "invalid credential catalog")?;
            let count = entries.len();
            for entry in entries {
                if entry.name <= after || all.len() >= 1000 {
                    return Err("invalid credential catalog pagination".into());
                }
                after = entry.name.clone();
                all.push(entry);
            }
            if count < 100 {
                return Ok(all);
            }
        }
    }
    fn recent_usage(&self, limit: usize) -> Result<Vec<SecretUseAuditRecord>, String> {
        let value = self.request(json!({"operation":"usage", "limit":limit.clamp(1,500)}))?;
        serde_json::from_value(value["records"].clone())
            .map_err(|_| "invalid credential usage audit".into())
    }
}
