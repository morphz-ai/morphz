//! Deployment policy only. Staying resident never grants execution authority
//! or suppresses ownership-loss shutdown, maintenance, recovery or cancellation.
use super::protocol::StoreError;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostComputePolicy {
    OnDemand { idle: Duration },
    AlwaysOn,
}

impl HostComputePolicy {
    /// Read before claiming a Cell or restoring configuration. Neither models
    /// nor Session settings may change this deployment-level decision.
    pub fn from_env() -> Result<Self, StoreError> {
        fn optional(name: &str) -> Result<Option<String>, StoreError> {
            match std::env::var(name) {
                Ok(value) => Ok(Some(value)),
                Err(std::env::VarError::NotPresent) => Ok(None),
                Err(_) => Err(format!("{name} must be valid text").into()),
            }
        }
        Self::parse(
            optional("MORPHZ_HOST_COMPUTE_MODE")?.as_deref(),
            optional("MORPHZ_HOST_IDLE_SECONDS")?.as_deref(),
        )
    }

    fn parse(mode: Option<&str>, seconds: Option<&str>) -> Result<Self, StoreError> {
        let idle = seconds
            .unwrap_or("60")
            .parse::<u64>()
            .ok()
            .filter(|seconds| *seconds > 0)
            .ok_or("MORPHZ_HOST_IDLE_SECONDS must be a positive integer")?;
        match mode.unwrap_or("on_demand") {
            "on_demand" => Ok(Self::OnDemand {
                idle: Duration::from_secs(idle),
            }),
            "always_on" => Ok(Self::AlwaysOn),
            _ => Err("MORPHZ_HOST_COMPUTE_MODE must be on_demand or always_on".into()),
        }
    }

    pub fn idle_timeout(self) -> Option<Duration> {
        match self {
            Self::OnDemand { idle } => Some(idle),
            Self::AlwaysOn => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::OnDemand { .. } => "on_demand",
            Self::AlwaysOn => "always_on",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_and_explicit_on_demand_keep_existing_idle_policy() {
        assert_eq!(
            HostComputePolicy::parse(None, None).unwrap().idle_timeout(),
            Some(Duration::from_secs(60))
        );
        assert_eq!(
            HostComputePolicy::parse(Some("on_demand"), Some("1"))
                .unwrap()
                .idle_timeout(),
            Some(Duration::from_secs(1))
        );
    }

    #[test]
    fn resident_mode_has_no_automatic_park_timeout() {
        let policy = HostComputePolicy::parse(Some("always_on"), Some("1")).unwrap();
        assert_eq!(policy, HostComputePolicy::AlwaysOn);
        assert_eq!(policy.idle_timeout(), None);
        assert_eq!(policy.name(), "always_on");
    }

    #[test]
    fn invalid_configuration_never_silently_selects_a_different_policy() {
        for mode in ["", "always", "ALWAYS_ON", "always_on "] {
            assert!(HostComputePolicy::parse(Some(mode), None).is_err());
        }
        for seconds in ["", "0", "-1", "1.5", " 1", "18446744073709551616"] {
            for mode in ["on_demand", "always_on"] {
                assert!(HostComputePolicy::parse(Some(mode), Some(seconds)).is_err());
            }
        }
    }
}
