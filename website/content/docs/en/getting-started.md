---
title: Getting started
description: Build Morphz, configure a model path, and receive the first real response.
section: start
order: 10
status: current
---

Morphz currently ships as a Rust binary with the Dashboard embedded. A first run is complete only after a request reaches a real model service and returns a response.

## Prerequisites

- The Rust toolchain pinned by `rust-toolchain.toml`;
- Access to at least one model service;
- Read and write access to the working directory.

## Build

From the repository root:

```bash
cargo build --release
```

The binary is written to `target/release/morphz`. Run it there or copy it to your executable path.

## Complete Setup

Setup opens the Dashboard wizard by default:

```bash
./target/release/morphz setup
```

Use the full-screen terminal wizard on SSH hosts or systems without a browser:

```bash
./target/release/morphz setup --tui
```

To print the Dashboard URL without opening a browser:

```bash
./target/release/morphz setup --no-open
```

A successful Setup persists a complete model service, auth account, and model route. An unfinished OAuth attempt does not become a selectable account.

## Verify the model path

Run the structural diagnostics first:

```bash
./target/release/morphz doctor
```

Then open Model Services in the Dashboard and test the account. A useful test result names the account, physical model, elapsed time, and any provider error. “Authenticated” only means credentials exist; it does not prove that a model request succeeds.

## Start the first conversation

Launch the interactive interface:

```bash
./target/release/morphz
```

Or provide a prompt directly:

```bash
./target/release/morphz inspect this project and explain what you can access
```

The first run is complete when a model response appears. If only user messages are visible, use [Operations and troubleshooting](/en/docs/operations) instead of creating more sessions.

## Next steps

- Read [Core concepts](/en/docs/core-concepts) to distinguish Contexts from Sessions;
- Read [Model services, accounts, and routes](/en/docs/providers-and-models) to understand the model selector;
- Read [Remote OAuth](/en/docs/remote-oauth) before deploying on a remote host.
