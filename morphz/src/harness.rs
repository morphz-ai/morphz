//! Minimal Domain Harness attachment boundary.
//!
//! This module intentionally does not freeze a complete Harness package or
//! DSL.  It defines only the stable facts the Runtime needs to attach one
//! primary Harness to an Objective/Evaluation and to validate artifact
//! movement without creating a second scheduler.

use std::collections::{HashMap, HashSet};
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

    /// Explicit contract: the successful entry String is the authored reply,
    /// rather than data for a subsequent model evaluation.
    fn publishes_entry_result(&self) -> bool {
        false
    }

    /// Canonical package-local `(fn ...)` sources. The Runtime admits and
    /// statically links these only through an exact Evaluation binding.
    fn function_sources(&self) -> Vec<String> {
        Vec::new()
    }

    /// Canonical package `(types ...)` declarations shared by exported HNS
    /// function interfaces. They are scoped to the exact Evaluation binding,
    /// never installed in a process-global language environment.
    fn type_sources(&self) -> Vec<String> {
        Vec::new()
    }

    /// Body-free declarations for exported functions. These are the only HNS
    /// functions visible to model-authored Yao programs.
    fn exported_function_interfaces(&self) -> Vec<String> {
        Vec::new()
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

type HarnessKey = (String, String);

#[derive(Default)]
struct RegistryState {
    harnesses: HashMap<HarnessKey, Arc<dyn DomainHarness>>,
    revision: u64,
}

/// A collection pass must not race an admission that has not yet committed
/// its durable binding. Capture leases *before* the asynchronous store read.
pub(crate) struct HarnessCollectionSnapshot {
    revision: u64,
    leased: HashSet<HarnessKey>,
}

#[derive(Default)]
pub struct HarnessRegistry {
    state: RwLock<RegistryState>,
}

impl HarnessRegistry {
    pub fn register(&self, harness: Arc<dyn DomainHarness>) -> Result<(), HarnessError> {
        let descriptor = harness.descriptor();
        if descriptor.id.trim().is_empty() || descriptor.version.trim().is_empty() {
            return Err("Harness id and version must not be empty".into());
        }
        let key = (descriptor.id.clone(), descriptor.version.clone());
        let mut state = self
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(existing) = state.harnesses.get(&key) {
            let existing_hash = existing.artifact_hash();
            let incoming_hash = harness.artifact_hash();
            if existing_hash.is_some() && existing_hash == incoming_hash {
                return Ok(());
            }
            return Err(format!(
                "Harness '{}@{}' is already registered and cannot be replaced by a different artifact",
                descriptor.id, descriptor.version
            )
            .into());
        }
        state.harnesses.insert(key, harness);
        state.revision = state.revision.wrapping_add(1);
        Ok(())
    }

    pub fn get(&self, id: &str, version: &str) -> Option<Arc<dyn DomainHarness>> {
        let mut state = self
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let harness = state
            .harnesses
            .get(&(id.to_string(), version.to_string()))
            .cloned();
        if harness.is_some() {
            state.revision = state.revision.wrapping_add(1);
        }
        harness
    }

    /// Retained packages may continue bound work, but cannot start new work.
    pub fn get_for_new_work(&self, id: &str, version: &str) -> Option<Arc<dyn DomainHarness>> {
        let mut state = self
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !current_descriptors(state.harnesses.values().map(|h| h.descriptor()).collect())
            .iter()
            .any(|h| h.id == id && h.version == version)
        {
            return None;
        }
        let harness = state
            .harnesses
            .get(&(id.to_string(), version.to_string()))
            .cloned();
        if harness.is_some() {
            state.revision = state.revision.wrapping_add(1);
        }
        harness
    }

    pub fn descriptors(&self) -> Vec<HarnessDescriptor> {
        let mut descriptors = self
            .state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .harnesses
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

    /// New work discovers the newest installed stable release, not every
    /// historical package. Older executables exist only for unfinished work;
    /// immutable source/binding history lives independently in the store.
    /// Opaque or equal-precedence versions stay explicit rather than guessing.
    pub fn discovery_descriptors(&self) -> Vec<HarnessDescriptor> {
        current_descriptors(self.descriptors())
    }

    pub fn retained_descriptors(&self) -> Vec<HarnessDescriptor> {
        let descriptors = self.descriptors();
        let current = current_descriptors(descriptors.clone());
        descriptors
            .into_iter()
            .filter(|h| !current.contains(h))
            .collect()
    }

    pub(crate) fn collection_snapshot(&self) -> HarnessCollectionSnapshot {
        let state = self
            .state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        HarnessCollectionSnapshot {
            revision: state.revision,
            leased: state
                .harnesses
                .iter()
                .filter(|(_, h)| Arc::strong_count(h) > 1)
                .map(|(key, _)| key.clone())
                .collect(),
        }
    }

    pub(crate) fn collect_unused(
        &self,
        snapshot: HarnessCollectionSnapshot,
        required: &[ExactHarnessRef],
    ) -> Vec<HarnessDescriptor> {
        let mut state = self
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.revision != snapshot.revision {
            return Vec::new();
        }
        let current =
            current_descriptors(state.harnesses.values().map(|h| h.descriptor()).collect());
        let mut keep = current
            .into_iter()
            .map(|h| (h.id, h.version))
            .collect::<HashSet<_>>();
        keep.extend(required.iter().map(|h| (h.id.clone(), h.version.clone())));
        keep.extend(snapshot.leased);
        let mut removed = Vec::new();
        state.harnesses.retain(|key, h| {
            if keep.contains(key) || Arc::strong_count(h) > 1 {
                true
            } else {
                removed.push(h.descriptor());
                false
            }
        });
        if !removed.is_empty() {
            state.revision = state.revision.wrapping_add(1);
        }
        removed.sort_by(|a, b| (&a.id, &a.version).cmp(&(&b.id, &b.version)));
        removed
    }
}

fn current_descriptors(descriptors: Vec<HarnessDescriptor>) -> Vec<HarnessDescriptor> {
    let mut families = std::collections::BTreeMap::<String, Vec<HarnessDescriptor>>::new();
    for descriptor in descriptors {
        families
            .entry(descriptor.id.clone())
            .or_default()
            .push(descriptor);
    }
    families
        .into_values()
        .flat_map(|family| {
            let versions = family
                .iter()
                .map(|descriptor| semver::Version::parse(&descriptor.version))
                .collect::<Result<Vec<_>, _>>();
            let Ok(versions) = versions else {
                return family;
            };
            let has_stable = versions.iter().any(|version| version.pre.is_empty());
            let latest = versions
                .iter()
                .filter(|version| !has_stable || version.pre.is_empty())
                .max_by(|left, right| left.cmp_precedence(right));
            family
                .into_iter()
                .zip(versions.iter())
                .filter(|(_, version)| {
                    latest.is_some_and(|latest| version.cmp_precedence(latest).is_eq())
                })
                .map(|(descriptor, _)| descriptor)
                .collect::<Vec<_>>()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct VersionedHarness(&'static str);

    impl DomainHarness for VersionedHarness {
        fn descriptor(&self) -> HarnessDescriptor {
            HarnessDescriptor {
                id: "test-upgrade".to_string(),
                version: self.0.to_string(),
                title: "Upgrade test".to_string(),
                capabilities: Vec::new(),
            }
        }
        fn compact_contract(&self) -> String {
            "Not mounted by discovery".to_string()
        }
    }

    #[test]
    fn new_work_discovers_latest_stable_without_erasing_exact_history() {
        let registry = HarnessRegistry::default();
        for version in ["1.4.10", "1.4.3", "1.4.9", "2.0.0-rc.1"] {
            registry
                .register(Arc::new(VersionedHarness(version)))
                .unwrap();
        }
        assert_eq!(registry.descriptors().len(), 4);
        let discovered = registry.discovery_descriptors();
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].version, "1.4.10");
        assert!(registry.get("test-upgrade", "1.4.3").is_some());
        assert!(registry.get("test-upgrade", "latest").is_none());
    }

    #[test]
    fn discovery_does_not_guess_opaque_or_equal_precedence_versions() {
        for versions in [["legacy", "1.0.0"], ["1.0.0+one", "1.0.0+two"]] {
            let registry = HarnessRegistry::default();
            for version in versions {
                registry
                    .register(Arc::new(VersionedHarness(version)))
                    .unwrap();
            }
            assert_eq!(registry.discovery_descriptors().len(), 2);
        }
        let registry = HarnessRegistry::default();
        for version in ["1.0.0-beta.2", "1.0.0-beta.10"] {
            registry
                .register(Arc::new(VersionedHarness(version)))
                .unwrap();
        }
        assert_eq!(registry.discovery_descriptors()[0].version, "1.0.0-beta.10");
    }

    fn upgrade_registry() -> HarnessRegistry {
        let registry = HarnessRegistry::default();
        for version in ["1.0.0", "2.0.0"] {
            registry
                .register(Arc::new(VersionedHarness(version)))
                .unwrap();
        }
        registry
    }

    #[test]
    fn obsolete_executables_are_collected_but_current_is_always_kept() {
        let registry = upgrade_registry();
        assert!(registry.get_for_new_work("test-upgrade", "1.0.0").is_none());
        let removed = registry.collect_unused(registry.collection_snapshot(), &[]);
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].version, "1.0.0");
        assert!(registry.get("test-upgrade", "1.0.0").is_none());
        assert!(registry.get_for_new_work("test-upgrade", "2.0.0").is_some());
    }

    #[test]
    fn unfinished_exact_reference_is_retained_without_becoming_a_new_work_option() {
        let registry = upgrade_registry();
        assert!(registry
            .collect_unused(
                registry.collection_snapshot(),
                &[ExactHarnessRef {
                    id: "test-upgrade".into(),
                    version: "1.0.0".into(),
                }]
            )
            .is_empty());
        assert_eq!(registry.retained_descriptors()[0].version, "1.0.0");
        assert!(registry.get_for_new_work("test-upgrade", "1.0.0").is_none());
        assert_eq!(
            registry
                .collect_unused(registry.collection_snapshot(), &[])
                .len(),
            1
        );
    }

    #[test]
    fn admission_started_after_snapshot_invalidates_collection_even_after_lease_drop() {
        let registry = upgrade_registry();
        let snapshot = registry.collection_snapshot();
        drop(registry.get("test-upgrade", "1.0.0").unwrap());
        // Simulates binding commit after the collector's database snapshot.
        assert!(registry.collect_unused(snapshot, &[]).is_empty());
        assert_eq!(
            registry
                .collect_unused(registry.collection_snapshot(), &[])
                .len(),
            1
        );
    }

    #[test]
    fn admission_already_in_progress_is_retained_for_the_whole_store_read() {
        let registry = upgrade_registry();
        let lease = registry.get("test-upgrade", "1.0.0").unwrap();
        let snapshot = registry.collection_snapshot();
        drop(lease);
        // The durable commit may have happened after the store read began;
        // an end-of-pass Arc count alone would wrongly collect this package.
        assert!(registry.collect_unused(snapshot, &[]).is_empty());
        assert_eq!(
            registry
                .collect_unused(registry.collection_snapshot(), &[])
                .len(),
            1
        );
    }

    #[test]
    fn concurrent_install_invalidates_collection_snapshot() {
        let registry = upgrade_registry();
        let snapshot = registry.collection_snapshot();
        registry
            .register(Arc::new(VersionedHarness("3.0.0")))
            .unwrap();
        assert!(registry.collect_unused(snapshot, &[]).is_empty());
        assert_eq!(
            registry
                .collect_unused(registry.collection_snapshot(), &[])
                .len(),
            2
        );
        assert_eq!(registry.discovery_descriptors()[0].version, "3.0.0");
    }

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
        assert!(error.to_string().contains("different artifact"));
    }
}
