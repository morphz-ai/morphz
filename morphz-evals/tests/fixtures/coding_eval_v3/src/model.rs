#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Policy {
    pub tenant: String,
    pub value: String,
    pub revision: u64,
}

impl Policy {
    pub fn new(tenant: impl Into<String>, value: impl Into<String>, revision: u64) -> Self {
        Self {
            tenant: tenant.into(),
            value: value.into(),
            revision,
        }
    }
}
