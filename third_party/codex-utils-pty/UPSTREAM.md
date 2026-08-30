# Upstream provenance

This crate is vendored from OpenAI Codex revision
`94cbbdd653d7c7b91856102817f6279a7e46bc85`, directory
`codex-rs/utils/pty`.

Morphz carries one compatibility fix at the Windows FFI boundary:

- convert the pseudo-console handle between the `winapi` and standard-library
  opaque pointer aliases without changing its value;
- consistently use `winapi::ctypes::c_void` for
  `UpdateProcThreadAttribute`.

The source files retain their upstream license headers. This local patch can be
removed once Morphz updates to a Codex revision containing the equivalent fix.
