//! Deterministic word segmentation shared by Recall indexing and querying.
//!
//! SQLite FTS5 ships no CJK-aware tokenizer. Its `trigram` tokenizer holds no
//! index entry for any term shorter than three characters, which silently
//! removes the most common Chinese word form — `权限`, `阈值`, `回滚` — from Recall entirely (`source-language: allow-non-english-example`).
//! Segmentation therefore happens in the
//! Runtime, and the physical index only has to split the result on whitespace.
//!
//! Indexing and querying must observe the same term boundaries, so both go
//! through [`segment_recall_terms`]. Anything that segments text by another
//! route will silently stop matching the stored Projection.

use crate::memory::normalize_recall_text;
use icu_segmenter::WordSegmenter;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

/// Identifies the segmentation contract inside `RecallIndexCapability`.
///
/// Changing the segmenter or its bundled dictionaries changes how documents
/// tokenize. A stored Projection is only comparable against a query produced
/// by the same value, so operators must be able to observe it and rebuild.
pub const RECALL_SEGMENTER: &str = "icu4x-word-auto-2";

/// Splits raw text into normalized lexical terms.
///
/// The input is NFKC-folded and lowercased first, so callers must not
/// pre-normalize. Segments carrying no alphanumeric character — punctuation
/// and whitespace runs — are dropped rather than indexed as terms.
pub fn segment_recall_terms(raw: &str) -> Vec<String> {
    let normalized = normalize_recall_text(raw);
    if normalized.is_empty() {
        return Vec::new();
    }
    let segmenter = WordSegmenter::new_auto(Default::default());
    let boundaries = segmenter.segment_str(&normalized).collect::<Vec<_>>();
    boundaries
        .windows(2)
        .map(|window| &normalized[window[0]..window[1]])
        .filter(|term| term.chars().any(char::is_alphanumeric))
        .map(str::to_string)
        .collect()
}

/// Recognizes the Agent's opt-in precision syntax.
///
/// A fully quoted query asks for an adjacent phrase instead of the default
/// broad recall. The Runtime never chooses this narrowing on the Agent's
/// behalf: retrieval stays recall-first unless the Agent asks otherwise.
pub fn recall_phrase_request(normalized_query: &str) -> (&str, bool) {
    let trimmed = normalized_query.trim();
    match trimmed
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
    {
        Some(inner) if !inner.trim().is_empty() => (inner, true),
        _ => (trimmed, false),
    }
}

/// Renders one complete logical document into the canonical text indexed by
/// Recall. The physical index has the same document boundary as the Event or
/// Frame; result previews, rather than storage truncation, bound what is shown
/// to an Agent.
pub fn segment_recall_text(raw: &str) -> String {
    segment_recall_terms(raw).join(" ")
}

/// Produces fixed-width physical-index keys for already segmented terms.
///
/// PostgreSQL GIN array entries inherit the backend's per-key size limit. A
/// fixed-width digest keeps that implementation detail from becoming a limit
/// on either the logical document or an unusually long term. Recall still
/// ranks and verifies candidates against the complete canonical text, so these
/// keys are only a lossless candidate accelerator, never returned as content.
pub(crate) fn recall_term_keys<'a>(terms: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut seen = HashSet::new();
    terms
        .into_iter()
        .filter(|term| !term.is_empty() && seen.insert(*term))
        .map(|term| format!("{:x}", Sha256::digest(term.as_bytes())))
        .collect()
}

/// Recovers the complete canonical text from the temporary chunked projection
/// used by releases from 2026-08-05 through 2026-08-15.
///
/// Those chunks repeated up to 32 whole terms at every boundary. Migration
/// removes the largest exact suffix/prefix overlap rather than indexing the
/// repeated terms twice. New writes never call this function.
pub(crate) fn merge_legacy_recall_chunks(chunks: &[String]) -> String {
    let mut merged = Vec::<String>::new();
    for chunk in chunks {
        let terms = chunk
            .split_whitespace()
            .filter(|term| !term.is_empty())
            .collect::<Vec<_>>();
        let overlap = (0..=merged.len().min(terms.len()).min(32))
            .rev()
            .find(|count| {
                merged[merged.len().saturating_sub(*count)..]
                    .iter()
                    .map(String::as_str)
                    .eq(terms[..*count].iter().copied())
            })
            .unwrap_or(0);
        merged.extend(terms[overlap..].iter().map(|term| (*term).to_string()));
    }
    merged.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chinese_two_character_words_are_standalone_terms() {
        // The regression this module exists to prevent: under `trigram` these
        // words produced no index entry at all.
        let terms = segment_recall_terms("用户权限管理模块");
        assert!(terms.contains(&"权限".to_string()), "terms: {terms:?}");
        assert!(terms.contains(&"用户".to_string()), "terms: {terms:?}");
        assert!(terms.iter().all(|term| term.chars().count() <= 3));
    }

    #[test]
    fn non_latin_scripts_segment_into_words_not_characters() {
        for (script, text, expected) in [
            ("japanese", "ユーザー権限管理モジュール", "ユーザー"),
            ("korean", "사용자 권한 관리", "사용자"),
            ("russian", "управление правами пользователя", "управление"),
            ("arabic", "إدارة أذونات المستخدم", "إدارة"),
        ] {
            let terms = segment_recall_terms(text);
            assert!(
                terms.contains(&expected.to_string()),
                "{script} lost word boundaries: {terms:?}"
            );
        }
    }

    #[test]
    fn mixed_script_text_keeps_latin_tokens_whole() {
        let terms = segment_recall_terms("修复 OAuth 权限 bug");
        // Normalization lowercases, so the Latin token is compared folded.
        assert_eq!(terms, vec!["修复", "oauth", "权限", "bug"]);
    }

    #[test]
    fn punctuation_and_whitespace_never_become_terms() {
        let terms = segment_recall_terms("  权限 ,  ;  管理 !!! ");
        assert_eq!(terms, vec!["权限", "管理"]);
        assert!(segment_recall_terms("   ,,, ;;; ").is_empty());
        assert!(segment_recall_terms("").is_empty());
    }

    #[test]
    fn index_and_query_paths_agree_on_boundaries() {
        // A query is only able to match the Projection when both sides derive
        // their terms from the same function.
        let indexed = segment_recall_text("用户权限管理模块");
        for term in segment_recall_terms("权限") {
            assert!(
                indexed.split_whitespace().any(|stored| stored == term),
                "indexed '{indexed}' does not contain query term '{term}'"
            );
        }
    }

    #[test]
    fn complete_document_keeps_content_beyond_the_old_storage_bound() {
        let text = format!("{} 终点火炬", "权限 ".repeat(20_000));
        let indexed = segment_recall_text(&text);
        assert!(indexed.chars().count() > 16 * 1024);
        assert!(indexed.ends_with("终点 火炬"));
    }

    #[test]
    fn legacy_chunk_merge_removes_only_boundary_overlap() {
        let chunks = vec![
            "alpha beta gamma".to_string(),
            "beta gamma delta epsilon".to_string(),
            "epsilon zeta".to_string(),
        ];
        assert_eq!(
            merge_legacy_recall_chunks(&chunks),
            "alpha beta gamma delta epsilon zeta"
        );
    }

    #[test]
    fn physical_term_keys_are_fixed_width_and_deduplicated() {
        let oversized = "x".repeat(100_000);
        let keys = recall_term_keys([oversized.as_str(), "ordinary", oversized.as_str()]);
        assert_eq!(keys.len(), 2);
        assert!(keys.iter().all(|key| key.len() == 64));
        assert_ne!(keys[0], keys[1]);
    }

    #[test]
    fn only_a_fully_quoted_query_requests_a_phrase() {
        assert_eq!(recall_phrase_request("\"权限 管理\""), ("权限 管理", true));
        assert_eq!(recall_phrase_request("权限 管理"), ("权限 管理", false));
        // A stray quote is ordinary text, not a half-open phrase request.
        assert_eq!(recall_phrase_request("\"权限"), ("\"权限", false));
        assert_eq!(recall_phrase_request("\"\""), ("\"\"", false));
    }

    #[test]
    fn full_width_input_normalizes_before_segmentation() {
        // NFKC folding runs first, so a full-width query still reaches the
        // same terms as its half-width form in the index.
        assert_eq!(
            segment_recall_terms("ＯＡｕｔｈ"),
            vec!["oauth".to_string()]
        );
    }
}
