//! Durable node identity and trust-on-first-contact pinning for an
//! operator-declared Coordination Mesh.

use crate::secret_store::{
    SecretScopeKind, SecretStore, SecretUseContext, HOST_ENV_FILE_SECRET_BACKEND_ID,
};
use base64::Engine as _;
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

type DynError = Box<dyn std::error::Error + Send + Sync>;

pub const NODE_IDENTITY_SECRET_ALIAS: &str = "MORPHZ_COORDINATION_NODE_IDENTITY_V1";

pub struct CoordinationNodeIdentity {
    key_pair: Arc<Ed25519KeyPair>,
    authority_id: String,
    public_key: String,
}

impl std::fmt::Debug for CoordinationNodeIdentity {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CoordinationNodeIdentity")
            .field("authority_id", &self.authority_id)
            .finish_non_exhaustive()
    }
}

impl CoordinationNodeIdentity {
    pub fn load_or_create(secret_store: &SecretStore) -> Result<Self, DynError> {
        let existing = secret_store
            .list()?
            .into_iter()
            .find(|entry| entry.name == NODE_IDENTITY_SECRET_ALIAS);
        let encoded = zeroize::Zeroizing::new(if let Some(existing) = existing {
            let encoded = secret_store
                .resolve(NODE_IDENTITY_SECRET_ALIAS, SecretUseContext::default())?
                .ok_or("Coordination Mesh node identity metadata has no stored value")?;
            if secret_store.backend_storage_kind(&existing.value_backend) == Some("native_keyring")
                && secret_store.has_backend(HOST_ENV_FILE_SECRET_BACKEND_ID)
            {
                // Do not synchronously delete the legacy Keychain copy here:
                // deletion can trigger a second authorization prompt. The
                // catalog switches atomically to the non-interactive copy, so
                // subsequent starts never touch the legacy item.
                secret_store.copy_to_backend_retaining_previous(
                    NODE_IDENTITY_SECRET_ALIAS,
                    &encoded,
                    SecretScopeKind::Runtime,
                    None,
                    HOST_ENV_FILE_SECRET_BACKEND_ID,
                )?;
                tracing::info!(
                        previous_backend = existing.value_backend,
                        backend = HOST_ENV_FILE_SECRET_BACKEND_ID,
                        event_code = "runtime.cognitive_coordination.identity_backend_migrated",
                        "Migrated the Runtime-owned Coordination Mesh identity to non-interactive host storage"
                    );
            }
            encoded
        } else {
            let document = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
                .map_err(|_| "failed to generate Coordination Mesh node identity")?;
            let encoded =
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(document.as_ref());
            if secret_store.has_backend(HOST_ENV_FILE_SECRET_BACKEND_ID) {
                secret_store.put_with_backend(
                    NODE_IDENTITY_SECRET_ALIAS,
                    &encoded,
                    SecretScopeKind::Runtime,
                    None,
                    HOST_ENV_FILE_SECRET_BACKEND_ID,
                )?;
            } else {
                secret_store.put(
                    NODE_IDENTITY_SECRET_ALIAS,
                    &encoded,
                    SecretScopeKind::Runtime,
                    None,
                )?;
            }
            encoded
        });
        Self::from_pkcs8_base64(encoded.as_str())
    }

    pub fn from_pkcs8_base64(encoded: &str) -> Result<Self, DynError> {
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded.trim())
            .map_err(|error| {
                format!("invalid Coordination Mesh node identity encoding: {error}")
            })?;
        let key_pair = Ed25519KeyPair::from_pkcs8(&bytes)
            .map_err(|_| "invalid Coordination Mesh Ed25519 node identity")?;
        let public_bytes = key_pair.public_key().as_ref();
        let public_key = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(public_bytes);
        let authority_id = authority_id_for_public_key(public_bytes);
        Ok(Self {
            key_pair: Arc::new(key_pair),
            authority_id,
            public_key,
        })
    }

    pub fn authority_id(&self) -> &str {
        &self.authority_id
    }

    pub fn public_key(&self) -> &str {
        &self.public_key
    }

    pub fn sign(&self, bytes: &[u8]) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(self.key_pair.sign(bytes).as_ref())
    }
}

pub fn authority_id_for_public_key(public_key: &[u8]) -> String {
    let digest = Sha256::digest(public_key);
    let short = digest[..18]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("morphz-node-{short}")
}

pub fn verify_identity_signature(
    authority_id: &str,
    public_key: &str,
    bytes: &[u8],
    signature: &str,
) -> Result<(), DynError> {
    let public_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(public_key)
        .map_err(|error| format!("invalid Coordination Mesh public key: {error}"))?;
    if authority_id_for_public_key(&public_bytes) != authority_id {
        return Err("Coordination Mesh Authority does not match its public key".into());
    }
    let signature = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|error| format!("invalid Coordination Mesh signature encoding: {error}"))?;
    UnparsedPublicKey::new(&ED25519, public_bytes)
        .verify(bytes, &signature)
        .map_err(|_| "invalid Coordination Mesh Ed25519 signature".into())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrustedCoordinationPeer {
    pub endpoint: String,
    pub authority_id: String,
    pub public_key: String,
    pub first_seen_at: chrono::DateTime<chrono::Utc>,
    pub last_seen_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TrustDocument {
    #[serde(default)]
    peers: Vec<TrustedCoordinationPeer>,
}

#[derive(Debug)]
pub struct CoordinationTrustStore {
    path: PathBuf,
    peers: RwLock<BTreeMap<String, TrustedCoordinationPeer>>,
}

impl CoordinationTrustStore {
    pub fn load(path: PathBuf) -> Result<Self, DynError> {
        let document = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<TrustDocument>(&bytes).map_err(|error| {
                format!(
                    "failed to parse Coordination Mesh trust store '{}': {error}",
                    path.display()
                )
            })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => TrustDocument::default(),
            Err(error) => {
                return Err(format!(
                    "failed to read Coordination Mesh trust store '{}': {error}",
                    path.display()
                )
                .into())
            }
        };
        let peers = document
            .peers
            .into_iter()
            .map(|peer| (peer.authority_id.clone(), peer))
            .collect();
        Ok(Self {
            path,
            peers: RwLock::new(peers),
        })
    }

    pub fn pin_or_verify(
        &self,
        endpoint: &str,
        authority_id: &str,
        public_key: &str,
    ) -> Result<(), DynError> {
        let now = chrono::Utc::now();
        let mut guard = self
            .peers
            .write()
            .map_err(|_| "Coordination Mesh trust-store lock is poisoned")?;
        if let Some(existing) = guard.get(authority_id) {
            if existing.public_key != public_key || existing.endpoint != endpoint {
                return Err(format!(
                    "Coordination Mesh identity changed for Authority '{authority_id}'"
                )
                .into());
            }
        }
        if let Some(existing) = guard
            .values()
            .find(|peer| peer.endpoint == endpoint && peer.authority_id != authority_id)
        {
            return Err(format!(
                "Coordination Mesh endpoint '{endpoint}' was previously pinned to Authority '{}'",
                existing.authority_id
            )
            .into());
        }
        let first_seen_at = guard
            .get(authority_id)
            .map(|peer| peer.first_seen_at)
            .unwrap_or(now);
        guard.insert(
            authority_id.to_string(),
            TrustedCoordinationPeer {
                endpoint: endpoint.to_string(),
                authority_id: authority_id.to_string(),
                public_key: public_key.to_string(),
                first_seen_at,
                last_seen_at: now,
            },
        );
        persist_trust_document(&self.path, guard.values())?;
        Ok(())
    }

    pub fn public_key(&self, authority_id: &str) -> Result<Option<String>, DynError> {
        Ok(self
            .peers
            .read()
            .map_err(|_| "Coordination Mesh trust-store lock is poisoned")?
            .get(authority_id)
            .map(|peer| peer.public_key.clone()))
    }

    pub fn endpoint(&self, authority_id: &str) -> Result<Option<String>, DynError> {
        Ok(self
            .peers
            .read()
            .map_err(|_| "Coordination Mesh trust-store lock is poisoned")?
            .get(authority_id)
            .map(|peer| peer.endpoint.clone()))
    }

    pub fn authority_for_endpoint(&self, endpoint: &str) -> Result<Option<String>, DynError> {
        Ok(self
            .peers
            .read()
            .map_err(|_| "Coordination Mesh trust-store lock is poisoned")?
            .values()
            .find(|peer| peer.endpoint == endpoint)
            .map(|peer| peer.authority_id.clone()))
    }
}

fn persist_trust_document<'a>(
    path: &Path,
    peers: impl Iterator<Item = &'a TrustedCoordinationPeer>,
) -> Result<(), DynError> {
    let parent = path
        .parent()
        .ok_or("Coordination Mesh trust-store path has no parent")?;
    std::fs::create_dir_all(parent)?;
    let mut peers = peers.cloned().collect::<Vec<_>>();
    peers.sort_by(|left, right| left.authority_id.cmp(&right.authority_id));
    let bytes = serde_json::to_vec_pretty(&TrustDocument { peers })?;
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(&temporary, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret_store::{
        HostEnvFileSecretBackend, SecretStore, SecretValueBackend, HOST_ENV_FILE_SECRET_BACKEND_ID,
    };
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    #[derive(Debug, Default)]
    struct MemoryBackend(Mutex<HashMap<String, String>>);

    impl SecretValueBackend for MemoryBackend {
        fn backend_id(&self) -> &'static str {
            "coordination_test_memory"
        }

        fn storage_kind(&self) -> &'static str {
            "memory"
        }

        fn put(&self, locator: &str, value: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(locator.into(), value.into());
            Ok(())
        }

        fn get(&self, locator: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(locator).cloned())
        }

        fn delete(&self, locator: &str) -> Result<bool, String> {
            Ok(self.0.lock().unwrap().remove(locator).is_some())
        }
    }

    #[derive(Debug, Default)]
    struct SimulatedNativeBackend {
        values: Mutex<HashMap<String, String>>,
        reads: AtomicUsize,
        deletes: AtomicUsize,
    }

    impl SecretValueBackend for SimulatedNativeBackend {
        fn backend_id(&self) -> &'static str {
            "simulated_native_keyring"
        }

        fn storage_kind(&self) -> &'static str {
            "native_keyring"
        }

        fn put(&self, locator: &str, value: &str) -> Result<(), String> {
            self.values
                .lock()
                .unwrap()
                .insert(locator.into(), value.into());
            Ok(())
        }

        fn get(&self, locator: &str) -> Result<Option<String>, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(self.values.lock().unwrap().get(locator).cloned())
        }

        fn delete(&self, locator: &str) -> Result<bool, String> {
            self.deletes.fetch_add(1, Ordering::SeqCst);
            Ok(self.values.lock().unwrap().remove(locator).is_some())
        }
    }

    #[test]
    fn node_identity_is_stable_in_the_secret_store() {
        let directory = tempfile::tempdir().unwrap();
        let store = SecretStore::new(
            directory.path().join("secrets.json"),
            Arc::new(MemoryBackend::default()),
        )
        .unwrap();
        let first = CoordinationNodeIdentity::load_or_create(&store).unwrap();
        let second = CoordinationNodeIdentity::load_or_create(&store).unwrap();
        assert_eq!(first.authority_id(), second.authority_id());
        assert_eq!(first.public_key(), second.public_key());
    }

    #[test]
    fn generated_node_identity_uses_noninteractive_host_storage() {
        let directory = tempfile::tempdir().unwrap();
        let native = Arc::new(SimulatedNativeBackend::default());
        let store = SecretStore::with_backends(
            directory.path().join("secrets.json"),
            native.backend_id(),
            vec![
                native.clone(),
                Arc::new(HostEnvFileSecretBackend::new(
                    directory.path().join("secrets.env"),
                )),
            ],
        )
        .unwrap();

        let first = CoordinationNodeIdentity::load_or_create(&store).unwrap();
        let second = CoordinationNodeIdentity::load_or_create(&store).unwrap();
        assert_eq!(first.authority_id(), second.authority_id());
        assert_eq!(native.reads.load(Ordering::SeqCst), 0);
        assert_eq!(
            store
                .list()
                .unwrap()
                .into_iter()
                .find(|entry| entry.name == NODE_IDENTITY_SECRET_ALIAS)
                .unwrap()
                .value_backend,
            HOST_ENV_FILE_SECRET_BACKEND_ID
        );
    }

    #[test]
    fn legacy_keychain_node_identity_migrates_once_without_changing_authority() {
        let directory = tempfile::tempdir().unwrap();
        let native = Arc::new(SimulatedNativeBackend::default());
        let store = SecretStore::with_backends(
            directory.path().join("secrets.json"),
            native.backend_id(),
            vec![
                native.clone(),
                Arc::new(HostEnvFileSecretBackend::new(
                    directory.path().join("secrets.env"),
                )),
            ],
        )
        .unwrap();
        let document = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(document.as_ref());
        let expected = CoordinationNodeIdentity::from_pkcs8_base64(&encoded).unwrap();
        store
            .put(
                NODE_IDENTITY_SECRET_ALIAS,
                &encoded,
                SecretScopeKind::Runtime,
                None,
            )
            .unwrap();

        let migrated = CoordinationNodeIdentity::load_or_create(&store).unwrap();
        assert_eq!(migrated.authority_id(), expected.authority_id());
        assert_eq!(native.reads.load(Ordering::SeqCst), 1);
        assert_eq!(native.deletes.load(Ordering::SeqCst), 0);
        assert_eq!(
            store
                .list()
                .unwrap()
                .into_iter()
                .find(|entry| entry.name == NODE_IDENTITY_SECRET_ALIAS)
                .unwrap()
                .value_backend,
            HOST_ENV_FILE_SECRET_BACKEND_ID
        );

        let restarted = CoordinationNodeIdentity::load_or_create(&store).unwrap();
        assert_eq!(restarted.authority_id(), expected.authority_id());
        assert_eq!(native.reads.load(Ordering::SeqCst), 1);
        assert_eq!(native.deletes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn identity_signatures_and_trust_pins_fail_closed() {
        let document = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let identity = CoordinationNodeIdentity::from_pkcs8_base64(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(document.as_ref()),
        )
        .unwrap();
        let signature = identity.sign(b"payload");
        verify_identity_signature(
            identity.authority_id(),
            identity.public_key(),
            b"payload",
            &signature,
        )
        .unwrap();
        assert!(verify_identity_signature(
            identity.authority_id(),
            identity.public_key(),
            b"changed",
            &signature,
        )
        .is_err());

        let directory = tempfile::tempdir().unwrap();
        let store = CoordinationTrustStore::load(directory.path().join("trust.json")).unwrap();
        store
            .pin_or_verify(
                "http://node-a:8080",
                identity.authority_id(),
                identity.public_key(),
            )
            .unwrap();
        assert_eq!(
            store
                .authority_for_endpoint("http://node-a:8080")
                .unwrap()
                .as_deref(),
            Some(identity.authority_id())
        );
        assert!(store
            .pin_or_verify(
                "http://node-b:8080",
                identity.authority_id(),
                identity.public_key(),
            )
            .is_err());
    }
}
