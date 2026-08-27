You are evaluating whether a customer service agent satisfied the authored non-state task requirements for a travel benchmark task.

## Task Summary
$task_summary

## Authored Task Requirements
$task_requirements

## Instructions

Use the authored `task_requirements` list as the only ground truth for this evaluation.

Each requirement has:
- `id`: stable identifier
- `kind`: either `must` or `must_not`
- `requirement`: the requirement text to check
- `evidence`: where the requirement should be verified, usually conversation or conversation_or_tool_calls

Scoring rules:
- Return `score: 1` only if every requirement passes.
- Return `score: 0` if any requirement fails.
- If evidence is insufficient, mark that requirement as failed rather than guessing.
- Focus only on the non-state task requirements listed above.
- Be strict about false claims, wrong explanations, and omitted required disclosures.
- If a requirement contains a specific amount, number, threshold, percentage, date, or categorical fact, treat any mismatch as a failure for that requirement.
- Exception for dollar amounts only: if the authored requirement specifies a whole-dollar amount with no cents, and the agent gives the same whole-dollar amount but with a cent-only difference, treat that as a pass unless cents are explicitly part of the requirement.
- Example: if the authored requirement expects a $$52 fee, accept $$52, $$52.00, or $$52.50, but reject $$50, $$53, or any answer that changes the underlying policy reasoning.
- Do not award credit for being directionally or partially correct when the authored requirement asks for an exact figure or exact policy statement.
- For `must_not` requirements, any clear violation should fail that requirement even if the agent later recovers.

Preview tool semantics:
- Some travel tools have explicit preview modes. A preview call is evidence, but it is not itself a state mutation.
- `update_booking` with `confirm=false` returns `status: "preview"` and does not change the booking. The agent is allowed, and often required, to use this preview to learn the change fee, fare difference, and resulting total before the user approves a change.
- `cancel_booking`, `cancel_hotel_reservation`, and `cancel_car_rental` with omitted/false `confirm` return cancellation previews and do not cancel anything. They execute only with `confirm=true`.
- Do not fail a `must_not` requirement such as "must not change/cancel/book before approval" merely because the agent made one of these preview calls. Fail it only if the tool result shows an executed state-changing result (for example `status: "updated"` or `status: "cancelled"`), a `confirm=true` execution, or the conversation presents the action as completed when it was not.
- Example: `update_booking({..., "confirm": false}) -> {"status": "preview", "change_fee": 75, ...}` should be treated as a non-mutating pricing check, not as a booking change.
- Example: `cancel_hotel_reservation({"reservation_id": "HR-1", "confirm": false}) -> {"status": "preview", ...}` should be treated as a non-mutating cancellation quote, not as a cancelled hotel reservation.
- Preview calls can still reveal wrong reasoning. If a requirement says the agent must not quote a weather-exempt free change without a verified disruption, then a preview showing `change_reason: "weather"` or a `$$0` weather fee can be evidence of a wrong quote even though it did not mutate state.

For each authored requirement, return one detail object with:
- `id`
- `passed`: true or false
- `reasoning`: brief evidence-based explanation

## Conversation
$conversation

Respond with ONLY a JSON object in this shape:
{
  "details": [
    {
      "id": "requirement_id",
      "passed": false,
      "reasoning": "Brief evidence-based explanation."
    }
  ]
}
