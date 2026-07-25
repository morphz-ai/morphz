use crate::Policy;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    pub invalidations: u64,
}

#[derive(Debug, Default)]
pub struct PolicyCache {
    entries: BTreeMap<String, Policy>,
    stats: CacheStats,
}

impl PolicyCache {
    pub fn get(&mut self, tenant: &str) -> Option<Policy> {
        let value = self.entries.get(tenant).cloned();
        if value.is_some() {
            self.stats.hits += 1;
        } else {
            self.stats.misses += 1;
        }
        value
    }

    pub fn insert(&mut self, policy: Policy) {
        self.entries.insert(policy.tenant.clone(), policy);
    }

    pub fn invalidate(&mut self, tenant: &str) {
        if self.entries.remove(tenant).is_some() {
            self.stats.invalidations += 1;
        }
    }

    pub fn stats(&self) -> CacheStats {
        self.stats
    }
}
