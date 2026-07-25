use crate::cache::{CacheStats, PolicyCache};
use crate::store::PolicyStore;
use crate::Policy;

#[derive(Debug, Default)]
pub struct PolicyService {
    store: PolicyStore,
    cache: PolicyCache,
}

impl PolicyService {
    pub fn read(&mut self, tenant: &str) -> Option<Policy> {
        if let Some(policy) = self.cache.get(tenant) {
            return Some(policy);
        }
        let policy = self.store.get(tenant).cloned();
        if let Some(policy) = &policy {
            self.cache.insert(policy.clone());
        }
        policy
    }

    pub fn upsert(&mut self, policy: Policy) -> bool {
        self.store.upsert(policy)
    }

    pub fn delete(&mut self, tenant: &str, expected_revision: u64) -> bool {
        self.store.delete(tenant, expected_revision)
    }

    pub fn cache_stats(&self) -> CacheStats {
        self.cache.stats()
    }
}
