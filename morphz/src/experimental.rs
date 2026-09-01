//! Explicit gates for unstable Morphz capabilities.
//!
//! Experimental code is protected twice: a Cargo feature decides whether it
//! is present in the binary, and an operator-owned runtime setting decides
//! whether the current process may use it. Stable Runtime behavior never
//! changes merely because experimental code was compiled in.

use serde::Serialize;
use std::collections::BTreeSet;
use std::fmt;

pub const COGNITIVE_COORDINATION: &str = "cognitive-coordination";
pub const CONTEXT_DB: &str = "context-db";
pub const COGNITIVE_COORDINATION_TOOL_NAME: &str = "coordinate";
pub const COGNITIVE_COORDINATION_PARTICIPANT_ACTOR: &str = "Cognitive-Coordination-Experiment";

#[cfg(feature = "experimental-cognitive-coordination")]
pub use morphz_cognitive_coordination as cognitive_coordination;
#[cfg(feature = "experimental-cognitive-coordination")]
pub mod cognitive_coordination_discovery;
#[cfg(feature = "experimental-cognitive-coordination")]
pub mod cognitive_coordination_identity;
#[cfg(feature = "experimental-cognitive-coordination")]
pub mod cognitive_coordination_network;
#[cfg(feature = "experimental-cognitive-coordination")]
pub mod cognitive_coordination_sdk;
#[cfg(feature = "experimental-context-db")]
pub mod context_db;
#[cfg(feature = "experimental-context-db")]
pub(crate) mod context_db_runtime;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExperimentalFeature {
    pub name: &'static str,
    pub cargo_feature: &'static str,
    pub summary: &'static str,
    pub compiled: bool,
}

pub const FEATURES: &[ExperimentalFeature] = &[
    ExperimentalFeature {
        name: COGNITIVE_COORDINATION,
        cargo_feature: "experimental-cognitive-coordination",
        summary: "coordinated multi-subject cognitive evaluation",
        compiled: cfg!(feature = "experimental-cognitive-coordination"),
    },
    ExperimentalFeature {
        name: CONTEXT_DB,
        cargo_feature: "experimental-context-db",
        summary: "authoritative Context AST database reference backend",
        compiled: cfg!(feature = "experimental-context-db"),
    },
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ExperimentalFeatureStatus {
    pub name: &'static str,
    pub cargo_feature: &'static str,
    pub summary: &'static str,
    pub compiled: bool,
    pub enabled: bool,
    pub available: bool,
}

/// Capability token proving that an experiment was both compiled and enabled
/// for this process. Experimental adapters require this token instead of
/// trusting a caller-supplied boolean or re-reading configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExperimentalFeaturePermit {
    feature: &'static ExperimentalFeature,
}

impl ExperimentalFeaturePermit {
    pub fn feature(self) -> &'static ExperimentalFeature {
        self.feature
    }

    pub fn permits(self, name: &str) -> bool {
        self.feature.name == name
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeatureGateError {
    Unknown {
        name: String,
    },
    NotCompiled {
        name: &'static str,
        cargo_feature: &'static str,
    },
    Disabled {
        name: &'static str,
    },
}

impl fmt::Display for FeatureGateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unknown { name } => write!(
                formatter,
                "unknown experimental feature '{name}'; known features: {}",
                known_feature_names().join(", ")
            ),
            Self::NotCompiled {
                name,
                cargo_feature,
            } => write!(
                formatter,
                "experimental feature '{name}' is enabled but was not compiled into this Morphz binary; rebuild with --features {cargo_feature}"
            ),
            Self::Disabled { name } => write!(
                formatter,
                "experimental feature '{name}' is compiled but not enabled for this process; add it to experimental.enabled or pass --enable-experimental {name}"
            ),
        }
    }
}

impl std::error::Error for FeatureGateError {}

pub fn known_feature_names() -> Vec<&'static str> {
    FEATURES.iter().map(|feature| feature.name).collect()
}

pub fn feature(name: &str) -> Result<&'static ExperimentalFeature, FeatureGateError> {
    FEATURES
        .iter()
        .find(|feature| feature.name == name)
        .ok_or_else(|| FeatureGateError::Unknown {
            name: name.to_string(),
        })
}

pub fn validate_enabled(enabled: &BTreeSet<String>) -> Result<(), FeatureGateError> {
    for name in enabled {
        feature(name)?;
    }
    Ok(())
}

pub fn require_all_enabled_compiled(enabled: &BTreeSet<String>) -> Result<(), FeatureGateError> {
    for name in enabled {
        require_enabled(enabled, name)?;
    }
    Ok(())
}

pub fn statuses(
    enabled: &BTreeSet<String>,
) -> Result<Vec<ExperimentalFeatureStatus>, FeatureGateError> {
    validate_enabled(enabled)?;
    Ok(FEATURES
        .iter()
        .map(|feature| {
            let is_enabled = enabled.contains(feature.name);
            ExperimentalFeatureStatus {
                name: feature.name,
                cargo_feature: feature.cargo_feature,
                summary: feature.summary,
                compiled: feature.compiled,
                enabled: is_enabled,
                available: feature.compiled && is_enabled,
            }
        })
        .collect())
}

pub fn require_enabled(
    enabled: &BTreeSet<String>,
    name: &str,
) -> Result<ExperimentalFeaturePermit, FeatureGateError> {
    let feature = feature(name)?;
    if !feature.compiled {
        return Err(FeatureGateError::NotCompiled {
            name: feature.name,
            cargo_feature: feature.cargo_feature,
        });
    }
    if !enabled.contains(feature.name) {
        return Err(FeatureGateError::Disabled { name: feature.name });
    }
    Ok(ExperimentalFeaturePermit { feature })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_features_are_rejected_instead_of_silently_ignored() {
        let enabled = BTreeSet::from(["typo".to_string()]);
        assert!(matches!(
            validate_enabled(&enabled),
            Err(FeatureGateError::Unknown { name }) if name == "typo"
        ));
    }

    #[test]
    fn availability_requires_both_compilation_and_operator_enablement() {
        let disabled = statuses(&BTreeSet::new()).unwrap();
        assert!(!disabled[0].available);

        let enabled = BTreeSet::from([COGNITIVE_COORDINATION.to_string()]);
        let enabled = statuses(&enabled).unwrap();
        assert_eq!(
            enabled[0].available,
            cfg!(feature = "experimental-cognitive-coordination")
        );
    }

    #[cfg(not(feature = "experimental-cognitive-coordination"))]
    #[test]
    fn requested_feature_missing_from_the_binary_fails_closed() {
        let enabled = BTreeSet::from([COGNITIVE_COORDINATION.to_string()]);
        assert!(matches!(
            require_all_enabled_compiled(&enabled),
            Err(FeatureGateError::NotCompiled { name, .. })
                if name == COGNITIVE_COORDINATION
        ));
    }

    #[cfg(feature = "experimental-cognitive-coordination")]
    #[test]
    fn enabled_compiled_feature_issues_a_scoped_permit() {
        let enabled = BTreeSet::from([COGNITIVE_COORDINATION.to_string()]);
        let permit = require_enabled(&enabled, COGNITIVE_COORDINATION).unwrap();
        assert!(permit.permits(COGNITIVE_COORDINATION));
    }
}
