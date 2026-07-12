//! Canonical Reality/Epistemic Contract definitions.
//!
//! These clauses are intentionally schema-light: they constrain how the Agent
//! uses Runtime evidence without prescribing the shape of Mind frame bodies.
//! System instructions, the Context protocol, and `context_tx` guidance must
//! all be rendered from this module so their semantics cannot drift apart.

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
        meaning: "seq 是 Ledger 的稳定物理写入顺序；较晚只表示后写入，不表示语义更正确或更权威",
    },
    ContractClause {
        key: "timestamp",
        meaning: "timestamp 是 Runtime 的观察或记录时间；它不等于来源声明时间或业务有效时间",
    },
    ContractClause {
        key: "direct-causality",
        meaning: "caused-by 只证明 Runtime 可观察的直接来源；先后或直接来源不自动证明完整业务因果",
    },
    ContractClause {
        key: "identity-routing",
        meaning: "session、turn、attempt、tool-call、Event 与 Frame 身份由 Runtime 维护；模型不得伪造或混淆路由",
    },
    ContractClause {
        key: "source-lineage",
        meaning: "from 来源必须真实存在且先于 transaction，Runtime 保存血缘；Runtime 不认证来源在语义上蕴含 BODY",
    },
    ContractClause {
        key: "resource-version",
        meaning: "resource identity、version、hash 与 latest 描述物理资源状态；latest 不表示内容更可信或业务上应采纳",
    },
    ContractClause {
        key: "tool-status",
        meaning: "工具状态区分 success、empty success、failed、rejected、timeout 与未知副作用；空输出成功不等于未执行",
    },
    ContractClause {
        key: "transaction",
        meaning: "Context transaction 原子且版本化，冲突不会静默覆盖；Runtime 保证物理提交，Agent 决定语义合并",
    },
    ContractClause {
        key: "resource-limits",
        meaning: "Token、Attempt、事务、时间、权限与并发边界是 Runtime 的物理约束，模型不能绕过",
    },
];

pub(crate) const EPISTEMIC_CONTRACT: &[ContractClause] = &[
    ContractClause {
        key: "observation-not-truth",
        meaning: "Observation 只证明 Runtime 观察到了该内容或结果，不自动证明其为外部世界真理",
    },
    ContractClause {
        key: "no-future-evidence",
        meaning: "证据实际出现之前，不得把未来实体、版本、身份、角色、阶段或状态写成当前事实",
    },
    ContractClause {
        key: "claims-no-stronger-than-sources",
        meaning: "derive/revise 的关键主张不得无理由强于 from 来源；来源存在不等于来源支持任意 BODY",
    },
    ContractClause {
        key: "unsupported-change-remains-uncertain",
        meaning: "来源只改变部分属性时，不得无证据连带改变实体身份、版本、角色、阶段或状态；额外变化应保持未知或显式作为推断",
    },
    ContractClause {
        key: "recency-usage-not-authority",
        meaning: "较新、latest、常被 recall 或常被引用都不自动代表更真实、更重要或更权威",
    },
    ContractClause {
        key: "direct-causality-only",
        meaning: "不得把物理先后或 caused-by 扩张为未经证据支持的业务因果关系",
    },
    ContractClause {
        key: "revise-on-counterevidence",
        meaning: "新证据反驳旧认识时，应保留来源与修订理由并 revise、retract、supersede 或恢复不确定性",
    },
    ContractClause {
        key: "final-source-check",
        meaning: "最终回复前检查关键事实、Mind 结论和来源边界；证据不足时如实表达未知、假设或阻塞",
    },
];

pub(crate) fn render_system_contract() -> String {
    let mut rendered = String::from(
        "以下契约由 Runtime 的单一协议定义生成，并与 Context protocol、context_tx 工具说明保持一致。它约束证据使用，但不规定 Mind BODY 的结构。\n\nRuntime Reality Contract（现实契约）：",
    );
    append_numbered_clauses(&mut rendered, REALITY_CONTRACT);
    rendered.push_str("\n\nAgent Epistemic Contract（认识契约）：");
    append_numbered_clauses(&mut rendered, EPISTEMIC_CONTRACT);
    rendered
}

pub(crate) fn render_context_tx_epistemic_guidance() -> String {
    EPISTEMIC_CONTRACT
        .iter()
        .map(|clause| format!("{}：{}", clause.key, clause.meaning))
        .collect::<Vec<_>>()
        .join("；")
}

fn append_numbered_clauses(rendered: &mut String, clauses: &[ContractClause]) {
    for (index, clause) in clauses.iter().enumerate() {
        rendered.push_str(&format!(
            "\n{}. `{}`：{}",
            index + 1,
            clause.key,
            clause.meaning
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_and_context_tx_renderers_share_the_canonical_epistemic_clauses() {
        let system = render_system_contract();
        let context_tx = render_context_tx_epistemic_guidance();
        for clause in EPISTEMIC_CONTRACT {
            assert!(system.contains(clause.key));
            assert!(system.contains(clause.meaning));
            assert!(context_tx.contains(clause.key));
            assert!(context_tx.contains(clause.meaning));
        }
        for clause in REALITY_CONTRACT {
            assert!(system.contains(clause.key));
            assert!(system.contains(clause.meaning));
        }
    }
}
