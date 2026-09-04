# Setup terminal wizard

`morphz setup --tui` configures model access before starting the Runtime. The
browser setup remains the default on desktop; an interactive headless terminal
can use the terminal wizard without a browser. It does not initialize a database
or start inference sessions merely to collect configuration.

## Presentation and navigation

- Use the main TUI's semantic theme and `❨ᴍ❩` mark, not a separate palette.
  The default is electric cyan. Respect `tui.theme`, `NO_COLOR`, and terminal
  light/dark appearance; never paint a background.
- All interface text follows the selected English or Simplified Chinese locale.
  Provider names, protocol identifiers, paths and diagnostic messages remain exact.
- Support 80×24 and compact terminals down to 40×16. Below that size, display a
  resize prompt. Choices scroll to keep selection visible; long notices scroll.
- Lists: arrows or `j`/`k`, Home/End, PageUp/PageDown, `/` to search, Enter to
  confirm. Search covers the entire catalog, including models after item 18.
  Esc clears an active search; otherwise Esc or Ctrl+C cancels the wizard.
- Inputs: Unicode-safe left/right, Home/End, Backspace/Delete, Ctrl+U to clear,
  bracketed paste. Default values are placeholders accepted with Enter; typing
  replaces the default. Secret input is masked, including during editing.

## Configuration and credentials

For API-key or anonymous services the steps are service, connection, credential,
model, then verification/review. Custom service identifiers, URLs and environment
variable names are validated before progressing. The operator can specify an
existing credential environment variable rather than relying on a fixed name.

Credentials entered in the wizard remain in memory during discovery and probes.
No credential file, OS credential-store write or default-model mutation occurs
before final confirmation. Verification uses the ordinary provider text/tool
handshake with a temporary client; it does not export the draft key to the process
environment or register a draft service. The operator can skip the two small
model requests. Unverified configurations are clearly marked and the final
confirmation defaults to cancelling rather than saving.

Discovery (45 seconds) and capability checks (90 seconds) are bounded and remain
responsive to cancellation and terminal resize. A catalog failure allows manual
model input; a probe failure allows an explicitly unverified save. These deadlines
apply only to network checks, not the time allowed for entering credentials or
responding to an OS authorization dialog.

After confirmation, save the selected credential and atomically write the routed
service/account/model configuration into the managed `models.toml`. Preserve
unrelated entries. The plaintext option uses the Morphz user `.env` file, with
an exclusive private temporary file and atomic replacement; Unix directory/file
modes are 0700/0600. Existing `export NAME=...` assignments are replaced rather
than creating conflicting duplicates. After saving, the chosen variable is made
available to the current process so first-run setup can continue without restart.

The OS credential-store write is not safely cancellable once issued. It runs off
the async worker, explains that it may require system authorization, and offers
retry or an **explicitly chosen** file backend on failure. There is no silent
fallback. A credential may remain if a subsequent configuration write fails;
these two stores do not form one transaction. The wizard must never claim otherwise.

## OAuth boundary

OAuth has three terminal steps: service, token storage, review/save. Saving creates
only the provider/account graph, not invented model routes or an authenticated
state. After the terminal is restored, the CLI invokes the existing Runtime login
path. The completion screen explicitly says login and model selection remain;
closing a saved receipt with Esc does not cancel the login handoff. Actual OAuth
authorization and model activation still use the shared account lifecycle and
Dashboard, not a duplicate terminal implementation.

## Regression coverage

`setup::tests` covers theme tokens, compact rendering, focus/caret behavior,
Unicode editing, validation, catalog search and secret-file preservation.
`morphz/tests/setup_tui.rs` drives the real binary through a PTY with an isolated
Morphz home and a synthetic loopback provider. It verifies complete configuration,
both streamed text and tool probes, cancellation during a pending request, Chinese
OAuth configuration without initiating login, and the non-interactive error.
These tests do not use real credentials, model quota or the OS credential store.
