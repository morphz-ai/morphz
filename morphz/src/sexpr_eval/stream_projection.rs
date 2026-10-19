//! Conservative compile-time projection of a suspended infer's String result.
//! This interprets only deterministic continuation structure, never Tools or
//! model text. Unknown transforms/effects disable preview, not execution.
use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplyProjectionCondition {
    pub path: Vec<String>,
    pub value: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplyProjection {
    pub path: Vec<String>,
    pub conditions: Vec<ReplyProjectionCondition>,
}
#[derive(Clone)]
enum Frame {
    Existing(MachineFrame),
    Expression(crate::yao::HirExpr),
    Bind(String),
    Restore(HashMap<String, JsonValue>, HashMap<String, Vec<String>>),
}
#[derive(Clone)]
struct State {
    frames: Vec<Frame>,
    env: HashMap<String, JsonValue>,
    origins: HashMap<String, Vec<String>>,
    current: Option<(Vec<String>, bool)>,
    conditions: Vec<ReplyProjectionCondition>,
}

fn origin(expression: &crate::yao::HirExpr, state: &State) -> Option<Vec<String>> {
    match &expression.kind {
        crate::yao::HirKind::Reference { root, path } => {
            let mut value = state.origins.get(root)?.clone();
            value.extend(path.iter().flatten().cloned());
            Some(value)
        }
        crate::yao::HirKind::Get { value, field } => {
            let mut value = origin(value, state)?;
            value.push(field.clone());
            Some(value)
        }
        _ => None,
    }
}

impl PlanMachine {
    /// A preview is admitted only when the remaining parent continuation can
    /// return an unchanged String leaf from THIS infer, with conditions on
    /// Bool leaves from that same value or actual already-bound constants.
    /// No name (including `reply`) or Harness has special behavior here.
    pub fn reply_projections(&self) -> Vec<ReplyProjection> {
        let Some(PlanEffect::Infer { result, .. }) = &self.pending else {
            return vec![];
        };
        let root_string = match result {
            InferResultKind::Json { ty, .. } => matches!(ty, crate::yao::Type::String),
            InferResultKind::Yao {
                ty: crate::yao::Type::String,
                ..
            } => true,
            // Tagged nominal Yao values and executable Program candidates
            // need another mapping; never guess their transport fields.
            _ => return vec![],
        };
        let mut pending = vec![State {
            frames: self.frames.iter().cloned().map(Frame::Existing).collect(),
            env: self.env.clone(),
            origins: HashMap::new(),
            current: Some((vec![], root_string)),
            conditions: vec![],
        }];
        let mut result = vec![];
        let mut budget = 256usize;
        while let Some(mut state) = pending.pop() {
            loop {
                if budget == 0 || pending.len() > 8 {
                    return vec![];
                }
                budget -= 1;
                let Some(frame) = state.frames.pop() else {
                    if let Some((path, true)) = state.current {
                        result.push(ReplyProjection {
                            path,
                            conditions: state.conditions,
                        });
                    }
                    break;
                };
                let frame = match frame {
                    Frame::Existing(MachineFrame::TypedSeq { steps, next }) => {
                        for expression in steps.into_iter().skip(next).rev() {
                            state.frames.push(Frame::Expression(expression));
                        }
                        continue;
                    }
                    Frame::Existing(MachineFrame::TypedBind { name }) => Frame::Bind(name),
                    Frame::Existing(MachineFrame::RestoreScope { saved_env, .. }) => {
                        Frame::Restore(saved_env, HashMap::new())
                    }
                    Frame::Existing(MachineFrame::TypedEval { expression }) => {
                        Frame::Expression(expression)
                    }
                    Frame::Existing(_) => break,
                    frame => frame,
                };
                match frame {
                    Frame::Bind(name) => {
                        if state.env.contains_key(&name) || state.origins.contains_key(&name) {
                            break;
                        }
                        if let Some((path, _)) = state.current.take() {
                            state.origins.insert(name, path);
                        } else {
                            break;
                        }
                    }
                    Frame::Restore(env, origins) => {
                        state.env = env;
                        state.origins = origins;
                    }
                    Frame::Expression(expression) => {
                        use crate::yao::HirKind;
                        match &expression.kind {
                            HirKind::Seq { steps } => {
                                for step in steps.iter().rev() {
                                    state.frames.push(Frame::Expression(step.clone()));
                                }
                            }
                            HirKind::Bind { name, value } => {
                                // Constant bindings can be evaluated by the existing pure evaluator.
                                if let Some(path) = origin(value, &state) {
                                    state.current =
                                        Some((path, matches!(value.ty, crate::yao::Type::String)));
                                    state.frames.push(Frame::Bind(name.clone()));
                                } else if value.effects.is_empty() {
                                    match crate::yao::evaluate_pure(
                                        value,
                                        &mut state.env,
                                        &self.typed_definitions,
                                    ) {
                                        Ok(value) => {
                                            state.env.insert(name.clone(), value);
                                            state.current = None;
                                        }
                                        Err(_) => break,
                                    }
                                } else {
                                    break;
                                }
                            }
                            HirKind::If {
                                condition,
                                when_true,
                                when_false,
                            } => {
                                if let Some(path) = origin(condition, &state) {
                                    if !matches!(condition.ty, crate::yao::Type::Bool) {
                                        break;
                                    }
                                    for (value, branch) in [(true, when_true), (false, when_false)]
                                    {
                                        let mut branch_state = state.clone();
                                        if branch_state
                                            .conditions
                                            .iter()
                                            .any(|guard| guard.path == path && guard.value != value)
                                        {
                                            continue;
                                        }
                                        branch_state.conditions.push(ReplyProjectionCondition {
                                            path: path.clone(),
                                            value,
                                        });
                                        branch_state.frames.push(Frame::Restore(
                                            state.env.clone(),
                                            state.origins.clone(),
                                        ));
                                        branch_state
                                            .frames
                                            .push(Frame::Expression((**branch).clone()));
                                        pending.push(branch_state);
                                    }
                                    break;
                                }
                                let Ok(JsonValue::Bool(value)) = crate::yao::evaluate_pure(
                                    condition,
                                    &mut state.env,
                                    &self.typed_definitions,
                                ) else {
                                    break;
                                };
                                state
                                    .frames
                                    .push(Frame::Restore(state.env.clone(), state.origins.clone()));
                                state.frames.push(Frame::Expression(if value {
                                    (**when_true).clone()
                                } else {
                                    (**when_false).clone()
                                }));
                            }
                            _ => {
                                if let Some(path) = origin(&expression, &state) {
                                    state.current = Some((
                                        path,
                                        matches!(expression.ty, crate::yao::Type::String),
                                    ));
                                } else if expression.effects.is_empty() {
                                    // A transformed or constant result has no identity projection.
                                    if crate::yao::evaluate_pure(
                                        &expression,
                                        &mut state.env,
                                        &self.typed_definitions,
                                    )
                                    .is_err()
                                    {
                                        break;
                                    }
                                    state.current = None;
                                } else {
                                    break;
                                }
                            }
                        }
                    }
                    Frame::Existing(_) => unreachable!(),
                }
            }
        }
        result.sort_by_key(|value| serde_json::to_string(value).unwrap_or_default());
        result.dedup();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn suspended(source: &str) -> PlanMachine {
        let registry = Registry::new();
        let program = validate(source, &registry, &AllowList::new(Vec::<String>::new())).unwrap();
        let mut machine = PlanMachine::new(&program).unwrap();
        assert!(matches!(
            machine.advance(&registry),
            PlanAdvance::Suspended(PlanEffect::Infer { .. })
        ));
        machine
    }
    #[test]
    fn unchanged_string_and_conditional_field_are_proven_from_the_real_continuation() {
        let simple = suspended(r#"(infer (requires (tools)) (returns String) "Return a String")"#);
        assert_eq!(
            simple.reply_projections(),
            vec![ReplyProjection {
                path: vec![],
                conditions: vec![]
            }]
        );
        let record = suspended(
            r#"(eval (requires (tools)) (types (record Decision (execute Bool) (answer String))) (seq (bind value (infer (returns Decision) "Produce a decision")) (if value.execute (infer (returns String) "Do work") value.answer)))"#,
        );
        assert_eq!(
            record.reply_projections(),
            vec![ReplyProjection {
                path: vec!["answer".into()],
                conditions: vec![ReplyProjectionCondition {
                    path: vec!["execute".into()],
                    value: false
                }]
            }]
        );
        let restored: PlanMachine =
            serde_json::from_value(serde_json::to_value(&record).unwrap()).unwrap();
        assert_eq!(record.reply_projections(), restored.reply_projections());
    }
    #[test]
    fn a_constant_replacement_or_later_effect_has_no_preview() {
        for source in [
            r#"(eval (requires (tools)) (seq (bind value (infer (returns String) "Return a String")) "a different result"))"#,
            r#"(eval (requires (tools)) (seq (bind value (infer (returns String) "Return a String")) (infer (returns String) "Produce another result")))"#,
        ] {
            assert!(suspended(source).reply_projections().is_empty());
        }
    }
}
