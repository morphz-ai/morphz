use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub type IdentityError = Box<dyn std::error::Error + Send + Sync>;

/// Authenticated, Runtime-authoritative identity. It is produced outside the
/// language-model prompt and can therefore safely anchor an Event.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PrincipalAssertion {
    pub principal_id: String,
    pub provider_id: String,
    pub assurance: String,
    pub display_name: Option<String>,
}

/// Opaque evidence supplied by an ingress adapter. Message text is
/// deliberately absent: natural-language identity claims are observations,
/// never authentication material.
#[derive(Clone)]
pub struct IdentityEvidence {
    pub channel: String,
    pub credential: Option<Arc<[u8]>>,
}

#[async_trait]
pub trait IdentityProvider: Send + Sync {
    fn provider_id(&self) -> &str;

    async fn authenticate(
        &self,
        evidence: IdentityEvidence,
    ) -> Result<PrincipalAssertion, IdentityError>;
}

/// Local/embedded default. Server products can replace this through the
/// Runtime builder with GitHub, OAuth, SSO or another provider.
pub struct StaticIdentityProvider {
    assertion: PrincipalAssertion,
}

impl StaticIdentityProvider {
    pub fn new(assertion: PrincipalAssertion) -> Self {
        Self { assertion }
    }
}

#[async_trait]
impl IdentityProvider for StaticIdentityProvider {
    fn provider_id(&self) -> &str {
        &self.assertion.provider_id
    }

    async fn authenticate(
        &self,
        _evidence: IdentityEvidence,
    ) -> Result<PrincipalAssertion, IdentityError> {
        Ok(self.assertion.clone())
    }
}
