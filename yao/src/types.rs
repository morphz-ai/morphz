use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum Type {
    Nil,
    Bool,
    Int,
    Float,
    String,
    Bytes,
    Json,
    List(Box<Type>),
    Map(Box<Type>),
    StructuralRecord(BTreeMap<String, Type>),
    Option(Box<Type>),
    Result {
        ok: Box<Type>,
        error: Box<Type>,
    },
    EvidenceCandidate,
    OutcomeCandidate,
    ContextTransaction,
    Ref(String),
    Program {
        output: Box<Type>,
        effects: EffectSet,
    },
    Named(String),
}

impl Type {
    pub fn is_assignable_to(&self, target: &Self) -> bool {
        if self == target || matches!(target, Self::Json) {
            return true;
        }
        match (self, target) {
            (Self::Int, Self::Float) => true,
            (Self::List(left), Self::List(right))
            | (Self::Map(left), Self::Map(right))
            | (Self::Option(left), Self::Option(right)) => left.is_assignable_to(right),
            (Self::StructuralRecord(left), Self::StructuralRecord(right)) => {
                right.iter().all(|(name, right_type)| {
                    left.get(name)
                        .is_some_and(|left_type| left_type.is_assignable_to(right_type))
                })
            }
            (
                Self::Result {
                    ok: left_ok,
                    error: left_error,
                },
                Self::Result {
                    ok: right_ok,
                    error: right_error,
                },
            ) => left_ok.is_assignable_to(right_ok) && left_error.is_assignable_to(right_error),
            (
                Self::Program {
                    output: left_output,
                    effects: left_effects,
                },
                Self::Program {
                    output: right_output,
                    effects: right_effects,
                },
            ) => {
                left_output.is_assignable_to(right_output) && left_effects.is_subset(right_effects)
            }
            _ => false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "name", rename_all = "snake_case")]
pub enum Effect {
    Infer,
    Tool(String),
    Host(String),
    Program(Box<EffectSet>),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EffectSet(BTreeSet<Effect>);

impl EffectSet {
    pub fn new(effects: impl IntoIterator<Item = Effect>) -> Self {
        Self(effects.into_iter().collect())
    }

    pub fn insert(&mut self, effect: Effect) -> bool {
        self.0.insert(effect)
    }

    pub fn contains(&self, effect: &Effect) -> bool {
        self.0.contains(effect)
    }

    pub fn is_subset(&self, other: &Self) -> bool {
        self.0.is_subset(&other.0)
    }

    pub fn union(&self, other: &Self) -> Self {
        Self(self.0.union(&other.0).cloned().collect())
    }

    pub fn iter(&self) -> impl Iterator<Item = &Effect> {
        self.0.iter()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl IntoIterator for EffectSet {
    type Item = Effect;
    type IntoIter = std::collections::btree_set::IntoIter<Effect>;

    fn into_iter(self) -> Self::IntoIter {
        self.0.into_iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assignability_is_explicit_and_program_effects_are_covariant_by_subset() {
        assert!(Type::Int.is_assignable_to(&Type::Float));
        assert!(!Type::Float.is_assignable_to(&Type::Int));
        assert!(Type::Named("Decision".into()).is_assignable_to(&Type::Json));
        assert!(!Type::Named("A".into()).is_assignable_to(&Type::Named("B".into())));

        let narrow = Type::Program {
            output: Box::new(Type::Int),
            effects: EffectSet::new([Effect::Tool("read".into())]),
        };
        let wide = Type::Program {
            output: Box::new(Type::Float),
            effects: EffectSet::new([Effect::Tool("read".into()), Effect::Infer]),
        };
        assert!(narrow.is_assignable_to(&wide));
        assert!(!wide.is_assignable_to(&narrow));
    }

    #[test]
    fn effect_sets_are_stable_deduplicated_and_ordered() {
        let effects = EffectSet::new([
            Effect::Tool("write".into()),
            Effect::Infer,
            Effect::Tool("read".into()),
            Effect::Infer,
        ]);
        assert_eq!(effects.iter().count(), 3);
        assert_eq!(effects.iter().next(), Some(&Effect::Infer));
    }
}
