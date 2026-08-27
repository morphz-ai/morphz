//! Canonical Reality/Epistemic Contract definitions.
//!
//! These clauses are intentionally schema-light: they constrain how the Agent
//! uses Runtime evidence without prescribing the shape of Mind frame bodies.
//! System instructions, the Context protocol, and `context_tx` guidance must
//! all be rendered from this module so their semantics cannot drift apart.

use crate::sexpr::SExpr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ContractClause {
    pub key: &'static str,
    pub meaning: &'static str,
}

pub(crate) const REALITY_CONTRACT_NAME: &str = "reality-contract-v1";
pub(crate) const EPISTEMIC_CONTRACT_NAME: &str = "epistemic-contract-v1";

pub(crate) const REALITY_CONTRACT: &[ContractClause] = &[
    ContractClause {
        key: "sequence",
        meaning: "seq is the stable physical Event append order; later means appended later, not semantically more correct or authoritative",
    },
    ContractClause {
        key: "timestamp",
        meaning: "timestamp is when the Runtime observed or recorded a fact; it is not the source-declared time or business-effective time",
    },
    ContractClause {
        key: "direct-causality",
        meaning: "caused-by proves only a direct source observable by the Runtime; ordering or direct origin does not prove complete business causality",
    },
    ContractClause {
        key: "identity-routing",
        meaning: "session, turn, attempt, tool-call, Event, and Frame identities are maintained by the Runtime; the model must not fabricate or conflate routes",
    },
    ContractClause {
        key: "source-lineage",
        meaning: "from sources must exist and precede the transaction; the Runtime preserves lineage but does not certify that a source semantically entails the BODY",
    },
    ContractClause {
        key: "resource-version",
        meaning: "resource identity, version, hash, and latest describe physical resource state; latest does not mean more trustworthy or preferable",
    },
    ContractClause {
        key: "tool-status",
        meaning: "tool status distinguishes success, empty success, failed, rejected, timeout, and unknown side effects; successful empty output does not mean the tool did not run",
    },
    ContractClause {
        key: "transaction",
        meaning: "Context transactions are atomic and versioned; Mind version is the physical commit sequence, while conflict boundaries are tracked per Frame content, lifecycle target, exact relation edge, Frame order, and checkpoint identity. The Runtime rebases a stale transaction only when all boundaries it reads or writes are unchanged; exact-boundary conflicts require the Agent to reread and merge semantically. rollback and Session-attention operations remain exact-version operations",
    },
    ContractClause {
        key: "resource-limits",
        meaning: "Token, Attempt, transaction, time, permission, and concurrency limits are physical Runtime constraints that the model cannot bypass",
    },
];

pub(crate) const EPISTEMIC_CONTRACT: &[ContractClause] = &[
    ContractClause {
        key: "observation-not-truth",
        meaning: "An Observation proves only that the Runtime observed the content or result; it does not automatically establish external-world truth",
    },
    ContractClause {
        key: "no-future-evidence",
        meaning: "Before evidence actually appears, future entities, versions, identities, roles, phases, or states must not be written as current facts",
    },
    ContractClause {
        key: "claims-no-stronger-than-sources",
        meaning: "Key claims in derive/revise must not be stronger than their from sources without justification; source existence does not support an arbitrary BODY",
    },
    ContractClause {
        key: "unsupported-change-remains-uncertain",
        meaning: "When a source changes only some properties, do not change identity, version, role, phase, or state without evidence; additional changes must remain unknown or be marked as inference",
    },
    ContractClause {
        key: "recency-usage-not-authority",
        meaning: "Newer, latest, frequently recalled, or frequently referenced does not automatically mean truer, more important, or more authoritative",
    },
    ContractClause {
        key: "direct-causality-only",
        meaning: "Do not expand physical ordering or caused-by into business causality unsupported by evidence",
    },
    ContractClause {
        key: "revise-on-counterevidence",
        meaning: "When new evidence contradicts prior knowledge, retain sources and revision rationale, then revise, retract, supersede, or restore uncertainty",
    },
    ContractClause {
        key: "final-source-check",
        meaning: "Before the final reply, check key facts, Mind conclusions, and source boundaries; when evidence is insufficient, state uncertainty, assumptions, or blockers honestly",
    },
];

pub(crate) fn render_system_contract() -> String {
    let mut rendered = String::from(
        "The following contracts are generated from one Runtime protocol definition and shared by the Context protocol and context_tx tool guidance. They constrain evidence use without prescribing Mind BODY structure.\n\nRuntime Reality Contract:",
    );
    append_numbered_clauses(&mut rendered, REALITY_CONTRACT);
    rendered.push_str("\n\nAgent Epistemic Contract:");
    append_numbered_clauses(&mut rendered, EPISTEMIC_CONTRACT);
    rendered
}

/// Render the same canonical contracts as an S-expression subtree for the
/// semantic VM system-prompt profile. Natural-language meanings remain inside
/// data nodes; no prose is placed outside the root expression.
pub(crate) fn render_system_contract_sexpr() -> String {
    let reality = contract_sexpr("reality-contract", REALITY_CONTRACT_NAME, REALITY_CONTRACT);
    let epistemic = contract_sexpr(
        "epistemic-contract",
        EPISTEMIC_CONTRACT_NAME,
        EPISTEMIC_CONTRACT,
    );
    SExpr::List(vec![
        atom("runtime-contracts"),
        field(
            "description",
            "These contracts are generated from one Runtime protocol definition and shared by the Context protocol and context_tx guidance. They constrain evidence use without prescribing Mind BODY structure.",
        ),
        reality,
        epistemic,
    ])
    .to_string()
}

pub(crate) fn render_context_tx_epistemic_guidance() -> String {
    EPISTEMIC_CONTRACT
        .iter()
        .map(|clause| format!("{}: {}", clause.key, clause.meaning))
        .collect::<Vec<_>>()
        .join("; ")
}

fn append_numbered_clauses(rendered: &mut String, clauses: &[ContractClause]) {
    for (index, clause) in clauses.iter().enumerate() {
        rendered.push_str(&format!(
            "\n{}. `{}`: {}",
            index + 1,
            clause.key,
            clause.meaning
        ));
    }
}

fn contract_sexpr(section: &str, name: &str, clauses: &[ContractClause]) -> SExpr {
    let mut values = vec![atom(section), field("name", name)];
    values.extend(clauses.iter().map(|clause| {
        SExpr::List(vec![
            atom("clause"),
            field("key", clause.key),
            field("meaning", clause.meaning),
        ])
    }));
    SExpr::List(values)
}

fn atom(value: impl ToString) -> SExpr {
    SExpr::Atom(value.to_string())
}

fn field(key: &str, value: impl ToString) -> SExpr {
    SExpr::List(vec![atom(key), atom(value)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_and_context_tx_renderers_share_the_canonical_epistemic_clauses() {
        let system = render_system_contract();
        let system_sexpr = render_system_contract_sexpr();
        let context_tx = render_context_tx_epistemic_guidance();
        for clause in EPISTEMIC_CONTRACT {
            assert!(system.contains(clause.key));
            assert!(system.contains(clause.meaning));
            assert!(system_sexpr.contains(clause.key));
            assert!(system_sexpr.contains(clause.meaning));
            assert!(context_tx.contains(clause.key));
            assert!(context_tx.contains(clause.meaning));
        }
        for clause in REALITY_CONTRACT {
            assert!(system.contains(clause.key));
            assert!(system.contains(clause.meaning));
            assert!(system_sexpr.contains(clause.key));
            assert!(system_sexpr.contains(clause.meaning));
        }
        crate::sexpr::parse(&system_sexpr).expect("SExpr contract must remain parseable");
    }
}
