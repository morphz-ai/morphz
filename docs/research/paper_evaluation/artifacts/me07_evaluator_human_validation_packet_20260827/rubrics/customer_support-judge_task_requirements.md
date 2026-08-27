You are evaluating whether a customer service agent satisfied the authored non-state task requirements for a customer-support benchmark task.

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
- Be strict about wrong denials, omitted disclosures, missing alternatives, and false claims about policy.
- If a requirement contains a specific amount, threshold, timeline, fee, membership rule, or policy condition, treat any mismatch as a failure for that requirement.
- For `must_not` requirements, any clear violation should fail that requirement even if the agent later recovers.

Preview tool semantics:
- Customer-support write tools are two-step tools. A preview call is evidence, but it is not itself a state mutation.
- `process_return`, `process_refund`, `cancel_order`, `process_exchange`, and `process_warranty_claim` with omitted/false `confirm` return `status: "preview"` and do not execute the return, refund, cancellation, exchange, or warranty claim.
- These preview calls are often required because they expose eligibility, fees, refund components, price differences, replacement options, or warranty resolution details that the agent must use before confirming.
- Do not fail a `must_not` requirement such as "must not process/refund/cancel/exchange before approval" merely because the agent made a preview call. Fail it only if the tool result shows an executed state-changing result, a `confirm=true` execution, or the conversation presents the action as completed when it was only previewed.
- Example: `process_return({"item_id": "ITEM-1", "reason": "changed_mind", "confirm": false}) -> {"status": "preview", ...}` should be treated as a non-mutating return quote, not as a processed return.
- Example: `process_refund({"item_id": "ITEM-1", "amount": 20, "confirm": false}) -> {"status": "preview", ...}` should be treated as a non-mutating refund preview, not as an issued refund.
- Preview calls can still reveal wrong reasoning. If a requirement says the agent must not offer an immediate refund as available before an investigation, then a preview may be evidence only if the agent presents that refund as available/done or the requirement explicitly forbids even offering it; the preview call alone is not a mutation.

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
