//! Isolated response-annotation mechanism. No Runtime integration, model calls,
//! dispatch, database, profile, or migration side effects are implemented here.
pub mod annotations;
pub mod stream;

pub use annotations::{augment_tools, normalize_response, Protocol};
