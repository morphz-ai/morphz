//! Bounded process-local OAuth refresh observations, never credential authority.
//! No account, token, URL, error text or request content is accepted by this API.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, MutexGuard};

const MAX_COUNTER: u64 = (1 << 53) - 1;

/// Operator-only process observations. A new manager has a new observation ID;
/// these counters are not durable audit, cross-restart totals or per-account
/// statistics. `incomplete` invalidates counter-difference acceptance checks.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OAuthRefreshDiagnostics {
    pub instance_id: Option<String>,
    pub started_at: DateTime<Utc>,
    pub incomplete: bool,
    pub requests_started: u64,
    pub requests_succeeded: u64,
    pub requests_failed: u64,
    /// Futures dropped before returning, including task cancellation/unwinding.
    pub requests_abandoned: u64,
    pub requests_active: u64,
    pub requests_peak_active: u64,
    pub lease_contentions: u64,
    /// Counts adapter.refresh invocations, not adapter-internal HTTP attempts.
    pub provider_calls_started: u64,
    pub provider_calls_active: u64,
    pub provider_calls_peak_active: u64,
    /// Successful conditional credential writes; account-state CAS is separate.
    pub credential_publications: u64,
}

pub(super) struct RefreshDiagnostics(Mutex<OAuthRefreshDiagnostics>);

fn increment(value: &mut u64, incomplete: &mut bool) {
    if *value >= MAX_COUNTER {
        *incomplete = true;
    } else {
        *value += 1;
    }
}

fn decrement(value: &mut u64, incomplete: &mut bool) {
    if *value == 0 {
        *incomplete = true;
    } else {
        *value -= 1;
    }
}

impl RefreshDiagnostics {
    pub fn new(instance_id: Option<String>) -> Self {
        Self(Mutex::new(OAuthRefreshDiagnostics {
            incomplete: instance_id.is_none(),
            instance_id,
            started_at: Utc::now(),
            requests_started: 0,
            requests_succeeded: 0,
            requests_failed: 0,
            requests_abandoned: 0,
            requests_active: 0,
            requests_peak_active: 0,
            lease_contentions: 0,
            provider_calls_started: 0,
            provider_calls_active: 0,
            provider_calls_peak_active: 0,
            credential_publications: 0,
        }))
    }

    fn state(&self) -> MutexGuard<'_, OAuthRefreshDiagnostics> {
        self.0.lock().unwrap_or_else(|error| {
            let mut state = error.into_inner();
            state.incomplete = true;
            state
        })
    }

    // Only short numeric updates hold this lock; no await, I/O or auth decision.
    pub fn snapshot(&self) -> OAuthRefreshDiagnostics {
        self.state().clone()
    }

    pub fn request(&self) -> RefreshRequest<'_> {
        let state = &mut *self.state();
        increment(&mut state.requests_started, &mut state.incomplete);
        increment(&mut state.requests_active, &mut state.incomplete);
        state.requests_peak_active = state.requests_peak_active.max(state.requests_active);
        RefreshRequest {
            diagnostics: self,
            finished: false,
        }
    }

    pub fn contention(&self) {
        let state = &mut *self.state();
        increment(&mut state.lease_contentions, &mut state.incomplete);
    }

    pub fn provider_call(&self) -> RefreshProviderCall<'_> {
        let state = &mut *self.state();
        increment(&mut state.provider_calls_started, &mut state.incomplete);
        increment(&mut state.provider_calls_active, &mut state.incomplete);
        state.provider_calls_peak_active = state
            .provider_calls_peak_active
            .max(state.provider_calls_active);
        RefreshProviderCall(self)
    }

    pub fn publication(&self) {
        let state = &mut *self.state();
        increment(&mut state.credential_publications, &mut state.incomplete);
    }
}

pub(super) struct RefreshRequest<'a> {
    diagnostics: &'a RefreshDiagnostics,
    finished: bool,
}

impl RefreshRequest<'_> {
    pub fn finish(mut self, succeeded: bool) {
        let state = &mut *self.diagnostics.state();
        decrement(&mut state.requests_active, &mut state.incomplete);
        if succeeded {
            increment(&mut state.requests_succeeded, &mut state.incomplete);
        } else {
            increment(&mut state.requests_failed, &mut state.incomplete);
        }
        self.finished = true;
    }
}

impl Drop for RefreshRequest<'_> {
    fn drop(&mut self) {
        if !self.finished {
            let state = &mut *self.diagnostics.state();
            decrement(&mut state.requests_active, &mut state.incomplete);
            increment(&mut state.requests_abandoned, &mut state.incomplete);
        }
    }
}

pub(super) struct RefreshProviderCall<'a>(&'a RefreshDiagnostics);

impl Drop for RefreshProviderCall<'_> {
    fn drop(&mut self) {
        let state = &mut *self.0.state();
        decrement(&mut state.provider_calls_active, &mut state.incomplete);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_counters_are_coherent_and_observation_only() {
        let diagnostics = RefreshDiagnostics::new(Some("synthetic-observation".into()));
        let first = diagnostics.request();
        let second = diagnostics.request();
        let abandoned = diagnostics.request();
        diagnostics.contention();
        let call = diagnostics.provider_call();
        let active = diagnostics.snapshot();
        assert_eq!(
            (active.requests_active, active.requests_peak_active),
            (3, 3)
        );
        assert_eq!(
            (active.provider_calls_started, active.provider_calls_active),
            (1, 1)
        );
        diagnostics.publication();
        drop(call);
        first.finish(true);
        second.finish(false);
        drop(abandoned);
        let after = diagnostics.snapshot();
        assert_eq!(after.requests_started, 3);
        assert_eq!(
            (
                after.requests_succeeded,
                after.requests_failed,
                after.requests_abandoned
            ),
            (1, 1, 1)
        );
        assert_eq!((after.requests_active, after.provider_calls_active), (0, 0));
        assert_eq!(
            (after.lease_contentions, after.credential_publications),
            (1, 1)
        );
        assert!(!after.incomplete);
        assert_eq!(diagnostics.snapshot(), after); // Read does not reset/advance.
    }

    #[test]
    fn counter_overflow_missing_identity_and_poison_invalidate_evidence_without_panicking() {
        let missing = RefreshDiagnostics::new(None);
        assert!(missing.snapshot().incomplete);
        missing.request().finish(true);
        let diagnostics = RefreshDiagnostics::new(Some("synthetic-observation".into()));
        diagnostics.state().requests_started = MAX_COUNTER;
        diagnostics.request().finish(true);
        assert_eq!(diagnostics.snapshot().requests_started, MAX_COUNTER);
        assert!(diagnostics.snapshot().incomplete);
        let poisoned = RefreshDiagnostics::new(Some("synthetic-observation".into()));
        let _ = std::panic::catch_unwind(|| {
            let _guard = poisoned.0.lock().unwrap();
            panic!("synthetic diagnostic panic");
        });
        poisoned.request().finish(false);
        assert!(poisoned.snapshot().incomplete);
        assert_eq!(poisoned.snapshot().requests_failed, 1);
    }
}
