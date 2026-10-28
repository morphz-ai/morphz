# Context input and output budget

Context maintenance is selected locally before ordinary inference. The admission
budget must describe the same physical request that the Provider serializes:

- A model profile's `context_window_tokens` covers input and output together.
- `llm.max_output_tokens` overrides the profile's `max_output_tokens`; otherwise
  the profile supplies the request's explicit output allowance.
- The physical input ceiling is the smaller of a declared `max_input_tokens`
  and the total window minus that same output allowance, where available.
- Context policy may reduce the input ceiling further. It cannot enlarge the
  physical ceiling. Model changes resolve the selected route's capacity again.
- Missing capacity metadata retains the existing Runtime fallback and is not
  evidence of an exact model limit. Unsupported output ranges and an output
  allowance that leaves no input capacity fail locally before transport.

The existing complete-work-prompt counter measures messages and tool schemas.
Its heuristic or usage-calibrated result remains an estimate, not the server's
tokenizer or billing result. Local critical pressure selects the existing bounded
maintenance projection. A genuine upstream context-limit response remains a
fallback for tokenizer, attachment, template or server-side differences.
Authentication failures must not be universally routed into Context maintenance.

## Kimi investigation, 2026-10-28

The installed CLIProxyAPI v8.0.35 forwarded `kimi-k3-256k` as `k3-256k` to
Kimi Code's native Responses endpoint. Its saved upstream response and client
response contained the same HTTP 400 error:
`Your request exceeded k3-256k model token limit: 262144`, with
`type=invalid_authentication_error`. The proxy did not create that conflicting
type. The installed executor preserves upstream error bodies:
[Kimi executor source](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.35/internal/runtime/executor/kimi_executor.go).

The failed request omitted `max_output_tokens`. The selected Morphz model
profile had no window or output allowance, so the Runtime treated its 262144
fallback as input capacity. The request's embedded local estimate was 192458 tokens,
below the 196608 warning threshold. Offline counting with the official K3
tokenizer gave 175115 tokens for serialized input and tool schemas; this is not
an exact count of the hosted service's hidden template. These facts do not prove
the hosted Responses service's omitted-output default, and must not be described
as proof that the input estimate alone caused the rejection.

The live native model catalog confirmed a 262144 window. A separate tiny
synthetic native Responses request accepted an explicit 131072 output allowance
(HTTP 200, completed, 100 input and 45 output tokens). This provides a verified
explicit budget rather than relying on an unobserved server default. With that
declared window and allowance, local input capacity is 131072; the failed request
would enter critical maintenance before ordinary inference. No real conversation
was resent for this probe, and the proxy was not modified. The transport fallback
recognizes only HTTP 400 with a structured error message of the captured explicit
model-token-limit form and a positive numeric limit. It retains the original
status/type/message; it does not convert an authentication type generally or
apply this exception to 401/403, rate limits, or arbitrary quoted text.

The deployed K3-256k profile instead uses a 32768 output allowance, matching the
existing Runtime reserve while leaving 229376 tokens (224K) for input within
the confirmed 262144 total window. The 131072 probe above validates support for
an explicit output allowance; it is not a claim about the omitted default or a
requirement to reserve half the window. This configuration change is scoped to
that provider/model, with other profiles and Session defaults preserved.

[Kimi Code model contracts](https://www.kimi.com/code/docs/en/kimi-code/models.html)
distinguish the fixed 256K model from models whose capacity depends on the plan.
Do not infer other routes' capacity merely from their display name.

## Desktop presentation

`session-context-budget.read` reuses the existing authorized Session/principal
binding. It reads the selected Session's budget plus at most 32 latest indexed
model-attempt metadata events, never a full conversation or reconstructed Context.
Subsequent numeric measurements arrive on the existing authorized event stream.
The composer shows estimated used/input ceiling and a ring percentage; a compact
editor uses the same Context budget CAS as Dashboard. Total model window and
reserved output remain separate. A change affects later requests, with a visible
shared-Context scope. Conflicts or unknown receipts require rereading, not replay.
Scope/model changes and an explicit open refresh the metadata. There is no healthy
polling loop. Unknown, not-started and failed reads do not manufacture a count or
block typing, create a Session or send a message. See the application contract in
[`composer-context-capacity.md`](../application/docs/composer-context-capacity.md).
