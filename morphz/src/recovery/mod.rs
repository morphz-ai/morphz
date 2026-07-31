//! Physical recovery and invariant quarantine.
//!
//! Recovery may restore leases, retry external boundaries or quarantine an
//! entity. It never manufactures an Objective decision, Thread outcome,
//! barrier or internal Signal.

pub mod reconciler;

pub use reconciler::{ReconcilerAction, ReconcilerPlan, SchedulerReconciler};
