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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HarnessBinding {
    pub harness_id: String,
    pub harness_version: String,
    pub objective_id: String,
    pub evaluation_id: String,
}

/// Domain semantics may narrow Runtime behavior and propose work, but cannot
/// execute physical effects or replace Scheduler/permission authority.
pub trait DomainHarness: Send + Sync {
    fn descriptor(&self) -> HarnessDescriptor;

    /// Stable, compact Context Encoding fragment. Implementations should put
    /// detailed procedures in discoverable Skills instead of this prefix.
    fn compact_contract(&self) -> String;

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
    harnesses: RwLock<HashMap<String, Arc<dyn DomainHarness>>>,
}

impl HarnessRegistry {
    pub fn register(&self, harness: Arc<dyn DomainHarness>) -> Result<(), HarnessError> {
        let descriptor = harness.descriptor();
        if descriptor.id.trim().is_empty() || descriptor.version.trim().is_empty() {
            return Err("Harness id 和 version 不能为空".into());
        }
        self.harnesses
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(descriptor.id, harness);
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn DomainHarness>> {
        self.harnesses
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(id)
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
        descriptors.sort_by(|left, right| left.id.cmp(&right.id));
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
            registry.get("coding").unwrap().compact_contract(),
            "(harness coding (version 1))"
        );
    }
}
