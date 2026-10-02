//! Legacy Agent ROM compatibility surface. New callers use `context::Custom`.
//! Persisted keys, version bodies and command receipt hashes are unchanged.

pub use crate::context::custom::{
    canonicalize_authoring_state, canonicalize_body, prepare_command, stable_entry_id,
    validate_candidate_records, validate_key, validate_selection, Custom as AgentRomRecord,
    CustomCommandReceipt as AgentRomCommandReceipt, CustomError as AgentRomError,
    CustomKey as AgentRomKey, CustomMutation as AgentRomMutation,
    PutCustomCommand as PutAgentRomCommand, ThreadCustomManifest as ThreadRomManifest,
};
pub use crate::memory::CustomStore as AgentRomStore;

pub const ROM_FORMAT_VERSION: u32 = crate::context::custom::CUSTOM_FORMAT_VERSION;
pub const ROM_COMPILER_VERSION: &str = crate::context::custom::LEGACY_ROM_COMPILER_VERSION;
pub const ROM_SYSTEM_RULE: &str = crate::context::custom::LEGACY_ROM_SYSTEM_RULE;
pub const ROM_MAX_ENTRY_BYTES: usize = crate::context::custom::CUSTOM_MAX_ENTRY_BYTES;
pub const ROM_MAX_SELECTED_BYTES: usize = crate::context::custom::CUSTOM_MAX_SELECTED_BYTES;
pub const ROM_MAX_SELECTED_ENTRIES: usize = crate::context::custom::CUSTOM_MAX_SELECTED_ENTRIES;
pub const ROM_MAX_DEPTH: usize = crate::context::custom::CUSTOM_MAX_DEPTH;
pub const ROM_MAX_NODES: usize = crate::context::custom::CUSTOM_MAX_NODES;

/// Legacy compiler identity for callers constructing a historical manifest.
pub fn compiler_hash() -> String {
    crate::context::custom::legacy_compiler_hash()
}

/// Legacy manifest identity. New callers use `context::custom::manifest_hash`.
pub fn manifest_hash(entries: &[AgentRomRecord]) -> String {
    crate::context::custom::legacy_manifest_hash(entries)
}
