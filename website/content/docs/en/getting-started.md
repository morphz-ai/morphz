---
title: Getting started
description: Install Morphz, configure a model path, and receive the first real response.
section: start
order: 10
status: current
---

Morphz ships as a prebuilt native binary with the Dashboard embedded. The first-run path covers installation, model configuration, and a live response check.

## Prerequisites

- macOS on Apple Silicon or Intel, x86_64 Linux, or x86_64 Windows;
- Access to at least one model service;
- Read and write access to the working directory.

## Install with one command

macOS and Linux:

```bash
curl -fsSL https://github.com/morphz-ai/morphz/releases/latest/download/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://github.com/morphz-ai/morphz/releases/latest/download/install.ps1 | iex
```

The installer detects the current platform, downloads the matching archive from GitHub Releases, verifies its SHA-256 checksum, and installs into the user path without requiring root or administrator access. Open a new terminal before continuing with Setup.

Updates are explicit and reuse the same verified GitHub Release assets:

```bash
morphz update status
morphz update
```

A successful update retains the previous main binary; use `morphz update rollback` when needed. The standalone `morphz-edge` Execution Target client follows a separate installation and update flow.

## Complete Setup

Setup opens the Dashboard wizard by default:

```bash
morphz setup
```

Use the full-screen terminal wizard on SSH hosts or systems without a browser:

```bash
morphz setup --tui
```

To print the Dashboard URL without opening a browser:

```bash
morphz setup --no-open
```

A successful Setup persists a complete model service, auth account, and model route. An OAuth account becomes selectable after its login flow completes successfully.

## Verify the model path

Run the structural diagnostics first:

```bash
morphz doctor
```

Then open Model Services in the Dashboard and test the account. Authentication confirms that credentials are stored; the account test also verifies the selected account, physical model, and live request path, and reports elapsed time or errors.

## Start the first conversation

Launch the interactive interface:

```bash
morphz
```

Or provide a prompt directly:

```bash
morphz inspect this project and explain what you can access
```

When the Dashboard displays a model response, the model path is verified and Morphz is ready for work. If the page shows only user messages, keep the current Session and trace its model request path with [Operations and troubleshooting](/en/docs/operations).

## Build from source

From the repository root, use the Rust toolchain pinned by `rust-toolchain.toml`:

```bash
cargo build --release
```

The resulting binary is `target/release/morphz`. Source builds support development, review, and independent reproduction; ordinary users can use the one-command installer above.

## Next steps

- Read [Core concepts](/en/docs/core-concepts) to distinguish Contexts from Sessions;
- Read [Sessions and concurrent work](/en/docs/sessions-and-concurrency) to understand independent workstreams over shared cognition;
- Read [Cognitive Applications, Harnesses, and Yao](/en/docs/cognitive-applications) to bind domain practice to an Objective;
- Read [Model services, accounts, and routes](/en/docs/providers-and-models) to understand the model selector;
- Read [Remote OAuth](/en/docs/remote-oauth) before deploying on a remote host.
