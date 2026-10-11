//! Shared retention predicate; backend differences are only JSON extraction.

pub(super) fn required_harnesses_sql(postgres: bool) -> String {
    let json = |key: &str| {
        if postgres {
            format!("e.payload->>'{key}'")
        } else {
            format!("json_extract(e.payload, '$.{key}')")
        }
    };
    let id = json("harness_id");
    let version = json("harness_version");
    let evaluation = json("evaluation_id");
    let objective = json("objective_id");
    let requested_id = json("requested_harness_id");
    let requested_version = json("requested_harness_version");
    format!(
        r#"
        WITH bindings AS (
          SELECT e.topic, {id} AS harness_id, {version} AS harness_version,
                 {evaluation} AS evaluation_id, {objective} AS objective_id
          FROM events e
          WHERE e.topic IN ('runtime/harness_binding', 'runtime/evaluation_harness_binding')
        ), required AS (
          SELECT b.harness_id, b.harness_version FROM bindings b
          WHERE (
            (b.topic = 'runtime/harness_binding' AND (
              NOT EXISTS (SELECT 1 FROM objectives o WHERE o.id = b.objective_id)
              OR EXISTS (SELECT 1 FROM objectives o WHERE o.id = b.objective_id
                         AND o.status NOT IN ('completed','cancelled','failed'))
            ))
            OR (b.topic = 'runtime/evaluation_harness_binding' AND (
              EXISTS (SELECT 1 FROM objectives o WHERE o.active_evaluation_id = b.evaluation_id
                      AND o.status NOT IN ('completed','cancelled','failed'))
              OR EXISTS (SELECT 1 FROM threads t
                         WHERE (t.root_turn_id = b.evaluation_id
                           OR t.origin_evaluation_id = b.evaluation_id
                           OR (t.supervisor_kind = 'evaluation' AND t.supervisor_id = b.evaluation_id))
                         AND (t.status = 'open' OR EXISTS (
                           SELECT 1 FROM schedules s WHERE s.thread_id = t.id
                           AND s.status NOT IN ('completed','cancelled')
                         )))
              OR EXISTS (SELECT 1 FROM thread_activations a
                         WHERE (a.root_turn_id = b.evaluation_id OR a.id = b.evaluation_id)
                         AND a.status IN ('queued','running'))
              OR EXISTS (SELECT 1 FROM schedules s WHERE s.source_turn_id = b.evaluation_id
                         AND s.status NOT IN ('completed','cancelled'))
              OR (
                NOT EXISTS (SELECT 1 FROM objectives o
                            WHERE o.id = b.objective_id OR o.active_evaluation_id = b.evaluation_id)
                AND NOT EXISTS (SELECT 1 FROM threads t
                            WHERE t.root_turn_id = b.evaluation_id)
                AND NOT EXISTS (SELECT 1 FROM thread_activations a
                            WHERE a.root_turn_id = b.evaluation_id OR a.id = b.evaluation_id)
              )
            ))
          )
          UNION
          SELECT p.harness_id, p.harness_version FROM plan_executions p
          WHERE p.status NOT IN ('succeeded','failed','cancelled')
            AND (p.harness_id IS NOT NULL OR p.harness_version IS NOT NULL)
          UNION
          SELECT {requested_id}, {requested_version} FROM events e
          WHERE e.topic = 'chat/user_message' AND {requested_id} IS NOT NULL AND (
            EXISTS (SELECT 1 FROM threads t WHERE t.root_turn_id = e.id
                    AND (t.status = 'open' OR EXISTS (
                      SELECT 1 FROM schedules s WHERE s.thread_id = t.id
                      AND s.status NOT IN ('completed','cancelled')
                    )))
            OR EXISTS (SELECT 1 FROM thread_activations a
                       WHERE (a.root_turn_id = e.id OR a.trigger_event_id = e.id)
                       AND a.status IN ('queued','running'))
            OR EXISTS (SELECT 1 FROM schedules s WHERE s.source_turn_id = e.id
                       AND s.status NOT IN ('completed','cancelled'))
            OR (NOT EXISTS (SELECT 1 FROM threads t WHERE t.root_turn_id = e.id)
                AND NOT EXISTS (SELECT 1 FROM thread_activations a WHERE a.root_turn_id = e.id))
          )
        )
        SELECT DISTINCT harness_id, harness_version FROM required
        ORDER BY harness_id, harness_version
    "#
    )
}
