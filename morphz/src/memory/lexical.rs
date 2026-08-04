//! Deterministic word segmentation shared by Recall indexing and querying.
//!
//! SQLite FTS5 ships no CJK-aware tokenizer. Its `trigram` tokenizer holds no
//! index entry for any term shorter than three characters, which silently
//! removes the most common Chinese word form — `权限`, `阈值`, `回滚` — from
//! Recall entirely. Segmentation therefore happens in the Runtime, and the
//! physical index only has to split the result on whitespace.
//!
//! Indexing and querying must observe the same term boundaries, so both go
//! through [`segment_recall_terms`]. Anything that segments text by another
//! route will silently stop matching the stored Projection.

use crate::memory::{
    normalize_recall_text, RECALL_SEARCHABLE_TEXT_MAX_CHARS, RECALL_SEARCH_CHUNK_OVERLAP_TERMS,
};
use icu_segmenter::WordSegmenter;

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

/// Renders every lexical term into bounded physical-index chunks.
///
/// A Recall document is one logical result but may occupy many physical rows.
/// Adjacent chunks repeat a small number of whole terms so a phrase crossing a
/// boundary remains discoverable. No suffix of a long Event or Frame is
/// discarded merely because its first chunk reached the storage bound.
pub fn segment_recall_chunks(raw: &str) -> Vec<String> {
    chunk_segmented_recall_terms(segment_recall_terms(raw))
}

/// Chunks text that has already passed through the Runtime segmenter. This is
/// used only for compatibility with pre-chunk Recall documents and migrations.
pub fn chunk_segmented_recall_text(segmented: &str) -> Vec<String> {
    chunk_segmented_recall_terms(
        segmented
            .split_whitespace()
            .filter(|term| !term.is_empty())
            .map(str::to_string)
            .collect(),
    )
}

fn chunk_segmented_recall_terms(terms: Vec<String>) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = Vec::<String>::new();
    let mut current_chars = 0_usize;

    for term in terms {
        let term_chars = term.chars().count();
        let separator = usize::from(!current.is_empty());
        if !current.is_empty()
            && current_chars + separator + term_chars > RECALL_SEARCHABLE_TEXT_MAX_CHARS
        {
            chunks.push(current.join(" "));
            current = current
                .into_iter()
                .rev()
                .take(RECALL_SEARCH_CHUNK_OVERLAP_TERMS)
                .collect::<Vec<_>>();
            current.reverse();
            current_chars = current
                .iter()
                .map(|term| term.chars().count())
                .sum::<usize>()
                + current.len().saturating_sub(1);
            while !current.is_empty()
                && current_chars + 1 + term_chars > RECALL_SEARCHABLE_TEXT_MAX_CHARS
            {
                let removed = current.remove(0);
                current_chars = current_chars
                    .saturating_sub(removed.chars().count())
                    .saturating_sub(usize::from(!current.is_empty()));
            }
        }

        if term_chars > RECALL_SEARCHABLE_TEXT_MAX_CHARS {
            if !current.is_empty() {
                chunks.push(current.join(" "));
                current.clear();
                current_chars = 0;
            }
            let chars = term.chars().collect::<Vec<_>>();
            for slice in chars.chunks(RECALL_SEARCHABLE_TEXT_MAX_CHARS) {
                chunks.push(slice.iter().collect());
            }
            continue;
        }

        if !current.is_empty() {
            current_chars += 1;
        }
        current_chars += term_chars;
        current.push(term);
    }
    if !current.is_empty() {
        chunks.push(current.join(" "));
    }
    chunks
}

/// Compatibility view used by callers that need one bounded string. New
/// Recall documents persist all chunks through [`segment_recall_chunks`].
pub fn segment_recall_text(raw: &str) -> String {
    segment_recall_chunks(raw)
        .into_iter()
        .next()
        .unwrap_or_default()
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
    fn storage_bound_chunks_on_whole_terms_without_losing_the_suffix() {
        let text = "权限 ".repeat(RECALL_SEARCHABLE_TEXT_MAX_CHARS);
        let chunks = segment_recall_chunks(&text);
        assert!(chunks.len() > 1);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.chars().count() <= RECALL_SEARCHABLE_TEXT_MAX_CHARS));
        assert!(chunks
            .iter()
            .flat_map(|chunk| chunk.split_whitespace())
            .all(|term| term == "权限"));
        assert!(chunks.last().unwrap().contains("权限"));
    }

    #[test]
    fn adjacent_chunks_overlap_to_preserve_boundary_phrases() {
        let prefix = "甲".repeat(RECALL_SEARCHABLE_TEXT_MAX_CHARS - " boundary".chars().count());
        let chunks = chunk_segmented_recall_text(&format!("{prefix} boundary phrase"));
        assert_eq!(chunks.len(), 2);
        assert!(chunks[0].ends_with("boundary"));
        assert!(chunks[1].starts_with("boundary phrase"));
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
