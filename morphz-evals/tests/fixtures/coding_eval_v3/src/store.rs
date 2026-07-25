use crate::Policy;
use std::collections::BTreeMap;

#[derive(Debug, Default)]
pub struct PolicyStore {
    policies: BTreeMap<String, Policy>,
}

impl PolicyStore {
    pub fn get(&self, tenant: &str) -> Option<&Policy> {
        self.policies.get(tenant)
    }

    /// Applies only a strictly newer revision.
    pub fn upsert(&mut self, policy: Policy) -> bool {
        if self
            .policies
            .get(&policy.tenant)
            .is_some_and(|current| current.revision >= policy.revision)
        {
            return false;
        }
        self.policies.insert(policy.tenant.clone(), policy);
        true
    }

    pub fn delete(&mut self, tenant: &str, expected_revision: u64) -> bool {
        if self
            .policies
            .get(tenant)
            .is_none_or(|current| current.revision != expected_revision)
        {
            return false;
        }
        self.policies.remove(tenant);
        true
    }
}
