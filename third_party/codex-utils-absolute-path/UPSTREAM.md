# Upstream provenance

This crate is derived from OpenAI Codex's `codex-utils-absolute-path` at revision
`94cbbddafc1776d5e377bca1b05932c697e82238` and remains under Apache-2.0.

Morphz keeps a local copy because the Windows sandbox command runner is launched under a
low-privilege account from non-interactive hosts. The upstream fallback calls
`SHGetKnownFolderPath`, which statically imports Shell32 into that bootstrap executable. Morphz
uses the already-explicit process environment for `~` expansion instead, avoiding GUI/Shell DLL
initialization before the runner's named-pipe handshake.
