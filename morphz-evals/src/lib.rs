//! Morphz evaluation fixtures, scorers, model matrices, and benchmark runners.
//!
//! This crate may depend on the production Runtime. The Runtime must never
//! depend on this crate.

pub mod context_long_run_eval;
pub mod context_metacognition_eval;
pub mod context_pressure_eval;
pub mod eval_sandbox;
pub mod long_horizon_agent_eval;
pub mod sexpr_bind_if_eval;
pub mod sexpr_process_eval;
pub mod sexpr_reply_eval;
