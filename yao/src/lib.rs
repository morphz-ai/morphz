//! Yao is the typed cognitive evaluation language shared by models and runtimes.
//!
//! This crate intentionally contains no Morphz scheduler, tool registry, model client, database,
//! or authority implementation. It owns source syntax, diagnostics, types, static effects, and
//! canonical representation. A host runtime supplies profiles and lowers validated programs to
//! its own durable authorities.

pub mod canonical;
pub mod diagnostic;
pub mod eval;
pub mod sema;
pub mod syntax;
pub mod types;

pub use canonical::{canonical_program, canonical_source, content_hash, program_hash};
pub use diagnostic::{Diagnostic, DiagnosticCode, SourceLocation, SourceSpan};
pub use eval::{
    decode_value, evaluate_pure, evidence_candidate_view, optional_reference_value,
    outcome_candidate_view, reference_value, reference_view, structural_record_field,
    structural_record_value, variant_view, EvalFailure, EvidenceCandidateView,
    OutcomeCandidateView,
};
pub use sema::{
    analyze, AnalysisLimits, AnalysisProfile, EvaluationOwner, HirExpr, HirKind, Program,
    StaticProfile, ToolSignature, TypeDefinition,
};
pub use syntax::{parse_all, parse_one, Atom, AtomKind, Expr, ParseLimits};
pub use types::{Effect, EffectSet, Type};
