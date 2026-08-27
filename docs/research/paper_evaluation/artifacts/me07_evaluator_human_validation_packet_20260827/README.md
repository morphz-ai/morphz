# ME-07 evaluator human validation packet

This directory contains the frozen, blinded 30-sample packet reserved for
calibrating the updated ME-07 task-requirement and UX judges. Two reviewers
must work independently. Review each `blinded_packet/HV-*.json` against the
corresponding frozen STATE-Bench task-requirement and UX rubrics, then complete
`rater_a_ratings.csv` or `rater_b_ratings.csv` without discussing scores.

Record task-requirement success as 0/1 and each UX dimension as an integer from
1 to 5. The automated state score is deterministic and is not re-judged here.
Do not infer or record the Agent arm.

The arm mapping and automated scores are intentionally excluded from this
reviewer packet. The sealed file remains off-repository until both rating files
are complete. Its frozen SHA-256 is recorded in `packet_manifest.json` as
`f37a826e2105bcbd27d5271e0955fcda90d191284a2711dd30ca6ab594a4014f`.
The manifest also records the deterministic selection seed, allocation, sample
hashes, and rubric hashes. `SHA256SUMS` covers every public file in this
directory; it intentionally does not and cannot cover the excluded sealed
mapping beyond the manifest's frozen hash.

Current status: packet generation and blinding audit complete; two independent
human ratings and the subsequent agreement/calibration analysis remain pending.
