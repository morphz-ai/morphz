//! The single compact, model-visible description of Yao.
//!
//! Normative prose lives in the language specification. This card is the
//! stable operational surface embedded once in Morphz Context Encoding. Tool
//! descriptions and Harnesses refer to it instead of maintaining dialects of
//! their own.

/// Internal schema revision for serialized typed Yao artifacts.
///
/// This is deliberately not an in-band source declaration. Yao source has no
/// `(version ...)` form; package versions and persisted HIR schema versions
/// are separate concerns.
pub const TYPED_IR_SCHEMA_VERSION: &str = "0.1";

/// Hard budget for the shared model-visible card. Keep this small enough to
/// replace, rather than add to, the historical prompt/tool descriptions.
pub const LANGUAGE_CARD_MAX_CHARS: usize = 4_800;

/// Canonical compact Yao Language Card. It must remain one valid S-expression.
pub const LANGUAGE_CARD: &str = r#"(language-card
  (name Yao)
  (role "typed cognitive evaluation language shared by the model and Runtime")
  (source
    (artifact "exactly one (eval ...) or (infer ...) root")
    (versioning "source has no version declaration; (version ...) is invalid")
    (declarations "optional (requires ...) then optional (types ...), before the body")
    (infer-boundary "nested infer may declare (captures NAME...) and (returns TYPE) before one complete BODY")
    (strings "double-quoted; escape backslash, quote, newline, return, and tab")
    (references "use bare lexical names: name or name.field; '$name' is invalid; bindings are immutable"))
  (ownership
    (eval "Runtime owns the loop and executes a typed plan")
    (infer "model owns the loop for the same complete Yao BODY; Runtime authority and typed result validation remain binding"))
  (types
    (builtins Nil Bool Int Float String Bytes Json EvidenceCandidate OutcomeCandidate ContextTransaction)
    (parameterized "(List T) (Map T) (Option T) (Result OK ERR) (Ref KIND) (Program T (effects ...))")
    (nominal "(types (record NAME (field TYPE)...) (union NAME (variant (field TYPE)...)...))")
    (boundary "Json must be decoded before narrower typed use"))
  (requirements
    (form "(requires (tools NAME...) (objects KIND...)); program effects are inferred")
    (advanced "optional (effects EFFECT...) is an explicit closed upper bound for interfaces and audits")
    (meaning "requirements narrow, never grant, Runtime authority"))
  (values
    (constructors "(list E...) (dict (KEY E)...) (record TYPE (FIELD E)...) (variant TYPE.VARIANT (FIELD E)...) (some E) (none TYPE) (ok E ERROR-TYPE) (err E OK-TYPE)")
    (collections "list is List<T> and dict is homogeneous Map<T>; fixed heterogeneous fields require a declared record")
    (semantic "(evidence (kind E) (value E) (refs REF...)) (outcome (status succeeded|failed|blocked) (value E) (evidence REF...)) (context-transaction (context REF) (transaction (context-tx ...)))")
    (pure "(get E FIELD) (decode TYPE E) (is TYPE E) (eq|ne|lt|le|gt|ge LEFT RIGHT) (and E...) (or E...) (not E) (add E...) (sub LEFT RIGHT) (mul E...) (div LEFT RIGHT)"))
  (control
    (forms "(seq E...) (bind NAME E) (if BOOL THEN ELSE) (fallback PRIMARY BACKUP) (map LIST NAME BODY)")
    (match "(match VALUE ((case TYPE.VARIANT (FIELD NAME)...) E)...); named-union cases are exhaustive")
    (hns-functions "the bound evaluation-profile may publish body-free (fn NAME (visibility exported) (description STRING) (params (ARG TYPE)...) (returns TYPE) (effects EFFECT...)) interfaces and shared (types ...); invoke one as (NAME (ARG EXPR)...); call is reserved for Runtime Tools")
    (rule "effectful results must first be bound; conditions, operands, arguments, and collections are pure"))
  (effects
    (call "(call TOOL (ARG EXPR...)...); arguments are checked against the Tool schema")
    (infer "(infer [(captures NAME...)] [(returns TYPE)] BODY); BODY uses this same language; captures are the only parent lexical values disclosed; without returns the BODY type is the result contract; ordinary returns must accept BODY type; Program returns synthesize a quarantined candidate; tools derive from BODY effects")
    (par "(par (branch NAME EXPR)...); at least two isolated branches, deterministic all-join result")
    (run "(run PROGRAM); executes only an admitted Program Value through a durable child execution and dispatches by its eval/infer owner")
    (host "(host.view REF (returns TYPE)) (evidence.commit CANDIDATE) (outcome.commit CANDIDATE) plus profile-published objective.*, context.*, and namespaced operations"))
  (program-value
    (transport "model returns exactly one raw Yao source artifact with an explicit (eval ...) or (infer ...) root; no JSON wrapper, Markdown fence, or explanatory text")
    (admission "Runtime parses, types, bounds effects, canonicalizes, hashes, persists, and revalidates authority before run")
    (forbidden "never eval a model-returned source string directly"))
  (result
    (text "String")
    (json "Json")
    (typed "the Runtime decodes and validates before deterministic flow"))
  (examples
    (pure "(eval (seq (bind total (add 20 22)) (mul total 2)))")
    (record "(eval (types (record Answer (value Int) (note String))) (record Answer (value 42) (note \"done\")))")
    (tool "(eval (requires (tools read)) (call read (path \"README.md\")))")
    (model "(infer (requires (tools read)) (returns String) (seq (bind source (call read (path \"README.md\"))) source))")))"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_card_is_parseable_bounded_and_unversioned() {
        crate::parse_one(LANGUAGE_CARD, crate::ParseLimits::default()).unwrap();
        assert!(LANGUAGE_CARD.len() <= LANGUAGE_CARD_MAX_CHARS);
        assert!(!LANGUAGE_CARD.contains("(version \""));
        assert!(LANGUAGE_CARD.contains("use bare lexical names"));
        assert!(LANGUAGE_CARD.contains("(bind total (add 20 22)) (mul total 2)"));
        assert!(LANGUAGE_CARD.contains("no JSON wrapper"));
        assert!(LANGUAGE_CARD.contains("(eval ...) or (infer ...) root"));
        assert!(LANGUAGE_CARD.contains("same complete Yao BODY"));
        assert!(LANGUAGE_CARD.contains("captures are the only parent lexical values disclosed"));
        assert!(LANGUAGE_CARD.contains("invoke one as (NAME (ARG EXPR)...)"));
        for form in ["(seq E...)", "(bind NAME E)", "(call TOOL", "(par (branch"] {
            assert!(LANGUAGE_CARD.contains(form), "missing {form}");
        }
    }
}
