//! Minimal Domain Harness attachment boundary.
//!
//! This module intentionally does not freeze a complete Harness package or
//! DSL.  It defines only the stable facts the Runtime needs to attach one
//! primary Harness to an Objective/Evaluation and to validate artifact
//! movement without creating a second scheduler.

use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};

use crate::artifact::ArtifactTransferRequest;

pub type HarnessError = Box<dyn Error + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HarnessDescriptor {
    pub id: String,
    pub version: String,
    pub title: String,
    /// Compact discoverable capability names. Detailed Skills remain lazy.
    pub capabilities: Vec<String>,
}

/// Public, transport-safe reference to one exact installed Harness package.
/// The Runtime deliberately does not resolve floating versions such as
/// `latest`, because a durable Evaluation must remain reproducible.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExactHarnessRef {
    pub id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HarnessBindingScope {
    /// Optional default inherited by each Evaluation started for an Objective.
    ObjectiveDefault,
    /// The authoritative, exact binding used by one Runtime Evaluation.
    Evaluation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HarnessBinding {
    pub harness_id: String,
    pub harness_version: String,
    pub artifact_hash: String,
    pub scope: HarnessBindingScope,
    pub objective_id: Option<String>,
    pub evaluation_id: Option<String>,
    /// Set when an Evaluation binding was materialized from an Objective
    /// default. Successor Activations share the same Evaluation identity and
    /// therefore read this same binding rather than creating a new one.
    pub inherited_from_objective_id: Option<String>,
}

/// Domain semantics may narrow Runtime behavior and propose work, but cannot
/// execute physical effects or replace Scheduler/permission authority.
pub trait DomainHarness: Send + Sync {
    fn descriptor(&self) -> HarnessDescriptor;

    /// Content-addressed identity of the normalized package. Custom in-process
    /// Harness implementations may omit it, but installable `.hns` packages
    /// must provide one so an exact version can never change underneath a
    /// durable binding.
    fn artifact_hash(&self) -> Option<String> {
        None
    }

    /// Stable, compact Context Encoding fragment. Implementations should put
    /// detailed procedures in discoverable Skills instead of this prefix.
    fn compact_contract(&self) -> String;

    /// Read-only default cognitive structure mounted for one bound
    /// Objective/Evaluation. This is not written into the Agent's persistent
    /// Mind automatically.
    fn default_mind(&self) -> Option<String> {
        None
    }

    /// Explicit `(eval ...)` or `(infer ...)` entry source, when this Harness
    /// is backed by an installable package.
    fn entry_program(&self) -> Option<String> {
        None
    }

    /// Domain-level validation only. Runtime Target authorization, Capability
    /// Lease and local sandbox checks still run afterwards and cannot be
    /// overridden by returning `Ok` here.
    fn validate_artifact_transfer(
        &self,
        _request: &ArtifactTransferRequest,
    ) -> Result<(), HarnessError> {
        Ok(())
    }
}

#[derive(Default)]
pub struct HarnessRegistry {
    harnesses: RwLock<HashMap<(String, String), Arc<dyn DomainHarness>>>,
}

impl HarnessRegistry {
    pub fn register(&self, harness: Arc<dyn DomainHarness>) -> Result<(), HarnessError> {
        let descriptor = harness.descriptor();
        if descriptor.id.trim().is_empty() || descriptor.version.trim().is_empty() {
            return Err("Harness id 和 version 不能为空".into());
        }
        let key = (descriptor.id.clone(), descriptor.version.clone());
        let mut harnesses = self
            .harnesses
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(existing) = harnesses.get(&key) {
            let existing_hash = existing.artifact_hash();
            let incoming_hash = harness.artifact_hash();
            if existing_hash.is_some() && existing_hash == incoming_hash {
                return Ok(());
            }
            return Err(format!(
                "Harness '{}@{}' 已注册，不能用不同 artifact 覆盖",
                descriptor.id, descriptor.version
            )
            .into());
        }
        harnesses.insert(key, harness);
        Ok(())
    }

    pub fn get(&self, id: &str, version: &str) -> Option<Arc<dyn DomainHarness>> {
        self.harnesses
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&(id.to_string(), version.to_string()))
            .cloned()
    }

    pub fn descriptors(&self) -> Vec<HarnessDescriptor> {
        let mut descriptors = self
            .harnesses
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .map(|harness| harness.descriptor())
            .collect::<Vec<_>>();
        descriptors.sort_by(|left, right| {
            left.id
                .cmp(&right.id)
                .then_with(|| left.version.cmp(&right.version))
        });
        descriptors
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct CodingHarness;

    impl DomainHarness for CodingHarness {
        fn descriptor(&self) -> HarnessDescriptor {
            HarnessDescriptor {
                id: "coding".to_string(),
                version: "1".to_string(),
                title: "Coding".to_string(),
                capabilities: vec!["repository".to_string(), "tests".to_string()],
            }
        }

        fn compact_contract(&self) -> String {
            "(harness coding (version 1))".to_string()
        }
    }

    #[test]
    fn registry_exposes_stable_compact_descriptors() {
        let registry = HarnessRegistry::default();
        registry.register(Arc::new(CodingHarness)).unwrap();
        let descriptors = registry.descriptors();
        assert_eq!(descriptors.len(), 1);
        assert_eq!(descriptors[0].id, "coding");
        assert_eq!(
            registry.get("coding", "1").unwrap().compact_contract(),
            "(harness coding (version 1))"
        );
    }

    #[test]
    fn registry_keeps_multiple_versions_without_implicit_latest_resolution() {
        struct VersionedHarness(&'static str);

        impl DomainHarness for VersionedHarness {
            fn descriptor(&self) -> HarnessDescriptor {
                HarnessDescriptor {
                    id: "coding".to_string(),
                    version: self.0.to_string(),
                    title: format!("Coding {}", self.0),
                    capabilities: Vec::new(),
                }
            }

            fn compact_contract(&self) -> String {
                format!("(harness coding (version {}))", self.0)
            }
        }

        let registry = HarnessRegistry::default();
        registry.register(Arc::new(VersionedHarness("1"))).unwrap();
        registry.register(Arc::new(VersionedHarness("2"))).unwrap();

        assert_eq!(registry.descriptors().len(), 2);
        assert!(registry.get("coding", "1").is_some());
        assert!(registry.get("coding", "2").is_some());
        assert!(registry.get("coding", "latest").is_none());
    }

    #[test]
    fn registry_rejects_same_version_with_ambiguous_identity() {
        let registry = HarnessRegistry::default();
        registry.register(Arc::new(CodingHarness)).unwrap();
        let error = registry.register(Arc::new(CodingHarness)).unwrap_err();
        assert!(error.to_string().contains("不能用不同 artifact 覆盖"));
    }
}
