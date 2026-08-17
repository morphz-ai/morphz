# DEMO-001 Transport Correction

> Date: 2026-08-17 (Asia/Shanghai)
>
> Scope: roadshow demo only; no paper protocol is changed.

## Invalid probe

The first attempted Normal smoke resolved `gpt-5.6-sol` through the host user's
base Morphz configuration. That route selected the deployed Agent instance's
`codex-subscription` account. The account had already been disabled, and its
first request returned `429 usage_limit_reached`.

This was a Harness transport-configuration error, not an Arm result and not
evidence about the account intended for the roadshow experiment. The probe:

- produced no model decision;
- is excluded from every score, table and claim;
- must not be retried through that account;
- leaves the three paired Arm cells unconsumed.

The immutable tag `demo-001-frozen-v2-20260817` records the mistaken transport
binding and is superseded for execution. It is not moved or rewritten.

## Correct binding

The corrected Harness loads the Morphz Profile `roadshow-demo-001` explicitly.
The Profile rebinds the logical model `gpt-5.6-sol` to the existing
CLIProxyAPI-compatible `custom/custom-default` service and account, with
physical model `gpt-5.6-sol` and reasoning `max`.

The Profile:

- contains no endpoint or credential;
- inherits the existing host-owned CLIProxyAPI service/account configuration;
- does not become the globally active Profile;
- is byte-checked against the frozen repository template before a request;
- is shared unchanged by all three Arms.

The corrected protocol identity is `frozen-v2.1`, and its intended selective
tag is `demo-001-frozen-v2.1-20260817`.

## Verified no-model preflight

The Morphz binding preflight resolved:

```text
profile        roadshow-demo-001
provider       custom
logical model  gpt-5.6-sol
physical model gpt-5.6-sol
reasoning      max
```

The preflight instantiated and bound the configured Runtime client but sent no
model request.
