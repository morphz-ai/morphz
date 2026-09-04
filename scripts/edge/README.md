# Morphz Edge release and installer tools

This directory owns the provider-neutral, signed one-command installation path.

## Build a signed manifest

Generate a P-256 release key outside the repository and retain only the public key in deployment inputs:

```bash
openssl ecparam -name prime256v1 -genkey -noout -out release-private.pem
openssl ec -in release-private.pem -pubout -out release-public.pem
```

Build the platform artifacts, then create and sign one manifest:

```bash
python3 scripts/edge/build_release_manifest.py \
  --version 0.1.0 \
  --signing-key release-private.pem \
  --output dist/manifest.json \
  --artifact macos=aarch64=dist/morphz-edge-macos-aarch64.tar.gz=https://releases.example/morphz-edge-macos-aarch64.tar.gz \
  --artifact linux=x86_64=dist/morphz-edge-linux-x86_64.tar.gz=https://releases.example/morphz-edge-linux-x86_64.tar.gz \
  --artifact windows=x86_64=dist/morphz-edge-windows-x86_64.zip=https://releases.example/morphz-edge-windows-x86_64.zip
```

macOS and Linux artifacts are tar.gz bundles whose entrypoint is `morphz-edge`. Windows artifacts
are ZIP bundles whose entrypoint is `morphz-edge.exe`; keep the Morphz Windows sandbox helper
executables beside it. Every bundle also carries the generated third-party license inventories and
vendored-source provenance records staged by `scripts/stage-release-legal.sh`.

## Render deployable installers

The checked-in installer sources fail closed while their public-key placeholder is present:

```bash
scripts/edge/render_installers.sh release-public.pem dist/installers
```

Publish `dist/installers/install` at the Shell installer URL and `dist/installers/install.ps1` at the PowerShell URL. Publish the manifest signature as the raw file `manifest.json.sig` next to the manifest. Never publish or commit the private key.

## Verify locally

The Shell contract test generates an ephemeral key, signs a local manifest, performs an installation with a fake Edge executable, rejects a tampered manifest, and verifies rollback after failed pairing:

```bash
scripts/edge/test_install.sh
```

Production acceptance additionally requires a real bootstrap on macOS arm64, Linux x86_64/arm64, and Windows x86_64 against a disposable Cloud Agent.
