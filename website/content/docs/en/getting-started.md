---
title: Getting started
description: Install Morphz, configure a model path, and receive the first real response.
section: start
order: 10
status: current
---

Morphz ships as a prebuilt native binary with the Dashboard embedded. A first run is complete only after a request reaches a real model service and returns a response.

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

A successful update retains the previous main binary; use `morphz update rollback` when needed. The standalone `morphz-edge` Execution Target client has its own installation and update lifecycle and is never installed or updated with the main program.

Before the repository is public, maintainers can test the same flow against private GitHub Releases by exporting `GH_TOKEN` or `GITHUB_TOKEN`. Set `MORPHZ_GITHUB_REPOSITORY=owner/repository` only when the release repository differs from the compiled default.

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

A successful Setup persists a complete model service, auth account, and model route. An unfinished OAuth attempt does not become a selectable account.

## Verify the model path

Run the structural diagnostics first:

```bash
morphz doctor
```

Then open Model Services in the Dashboard and test the account. A useful test result names the account, physical model, elapsed time, and any provider error. “Authenticated” only means credentials exist; it does not prove that a model request succeeds.

## Start the first conversation

Launch the interactive interface:

```bash
morphz
```

Or provide a prompt directly:

```bash
morphz inspect this project and explain what you can access
```

The first run is complete when a model response appears. If only user messages are visible, use [Operations and troubleshooting](/en/docs/operations) instead of creating more sessions.

## Build from source

For development, review, or independent reproduction, use the Rust toolchain pinned by `rust-toolchain.toml` from the repository root:

```bash
cargo build --release
```

The resulting binary is `target/release/morphz`. Source builds are not the default installation path for ordinary users.

## Next steps

- Read [Core concepts](/en/docs/core-concepts) to distinguish Contexts from Sessions;
- Read [Model services, accounts, and routes](/en/docs/providers-and-models) to understand the model selector;
- Read [Remote OAuth](/en/docs/remote-oauth) before deploying on a remote host.
