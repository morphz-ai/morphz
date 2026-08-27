# Yao Complete-BODY `infer` Live Verification — 2026-08-28

## Scope

This record verifies the implementation in commit
`bdbe0b6fe3fc5311ae47ce0ace8c0dfa27beeee5`. It supplements deterministic tests with two live
model smokes through Morphz's normal provider path. It is implementation evidence, not a
performance benchmark or a claim that every Yao operator has been exercised with a live model.

Both smokes used the configured route `custom:gpt-5.6-sol`, physical model `gpt-5.6-sol`,
reasoning effort `max`, and the `openai-responses` protocol. Credentials, provider continuations,
and database files are deliberately excluded from this record.

## Pure complete BODY

The Runtime-owned parent evaluated:

```lisp
(eval
  (infer
    (seq
      (bind total (add 20 22))
      (if (gt total 40) (mul total 2) 0))))
```

Durable evidence:

- Session: `infer-live-clean-20260828`
- Infer request event:
  `infer_request_fb53ed1ac8016c7aa0830eca7bd0872480b61a60e684904d342c2025b91b466f`
- The request text contained the complete canonical BODY
  `(infer (seq (bind total (add 20 22)) (if (gt total 40) (mul total 2) 0)))` rather than a
  task/evidence lowering.
- Exactly one `chat/infer_request` was committed for the session.
- Plan execution:
  `plan_d78f55b029977dbaf496271d25328064475a2a922a068887fa1462abb9b9f6cf`
- Terminal Plan status: `succeeded`
- Typed result: `84`

## Complete BODY with an ordinary Tool call

The Runtime-owned parent evaluated:

```lisp
(eval
  (requires (tools read))
  (infer (call read (path "probe.txt"))))
```

Durable evidence:

- Session: `infer-live-tool-20260828`
- Infer request event:
  `infer_request_21b24099fde1ea12c87d9d7ec5fd123eb5ae3260713e03280d2916e14cdbd31b`
- The request text contained the complete canonical BODY
  `(infer (call read (path "probe.txt")))`.
- Exactly one `chat/infer_request` was committed for the session.
- The model-owned Evaluation issued one `read` Tool call with `{"path":"probe.txt"}`. The
  initial outer Agent invocation of the `eval` Tool is a separate call and is not counted as an
  infer-BODY Tool call.
- Plan execution:
  `plan_f69551a44d6381ff141e811c8aa4b313961f25de18c0d542a417e30799f4238f`
- Terminal Plan status: `succeeded`
- The typed JSON result contained marker `MORPHZ-INFER-BODY-TOOL-SMOKE-20260828` read from the
  fixture file.

## Source-authorized capture boundary

The confidentiality boundary is covered by deterministic language, Plan Machine, durable
reconstruction, and production-path tests rather than by sending an actual secret to a provider.
They verify all of the following:

- `(captures base)` serializes only the bound value of `base` into the internal infer request;
- an unlisted sibling binding is absent from that request and from the provider-facing prompt;
- an implicit Runtime binding is unavailable inside a nested model-owned BODY unless the source
  explicitly captures it;
- a named capture authorizes value disclosure only and does not add Tool, Host, or object
  capabilities.

Principal tests:

- `nested_model_body_captures_only_explicit_parent_bindings`
- `complete_yao_body_sends_only_source_authorized_lexical_captures`
- `complete_infer_body_and_explicit_captures_survive_durable_reconstruction`
- `infer_discloses_only_source_authorized_parent_bindings_to_the_model`

## Automated gates

- Yao: 47 passed
- Removed fixed-field source forms are covered by
  `fixed_infer_request_syntax_is_rejected_at_every_root` at top-level `infer` and nested under
  `eval`.
- Morphz infer evaluator suite: 48 passed
- Morphz production attempt loop: 74 passed
- Durable infer handoff: 4 passed
- Clippy for `yao-lang` and `morphz` with `-D warnings`: passed
- `cargo fmt --all -- --check`: passed
- `git diff --check`: passed
