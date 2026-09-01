#!/bin/sh
set -eu

fail() {
  printf '%s\n' "edge installer test: $*" >&2
  exit 1
}

script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
temporary=$(mktemp -d "${TMPDIR:-/tmp}/morphz-edge-installer-test.XXXXXX")
cleanup() { rm -rf "$temporary"; }
trap cleanup EXIT HUP INT TERM

private_key="$temporary/release-private.pem"
public_key="$temporary/release-public.pem"
artifact="$temporary/morphz-edge-fixture"
argument_log="$temporary/edge-arguments.log"
workspace="$temporary/workspace"
mkdir -p "$workspace"

openssl ecparam -name prime256v1 -genkey -noout -out "$private_key"
openssl ec -in "$private_key" -pubout -out "$public_key" >/dev/null 2>&1

cat > "$artifact" <<'SH'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${MORPHZ_EDGE_TEST_ARGUMENT_LOG:?}"
case " $* " in
  *" bootstrap "*)
    [ "${MORPHZ_EDGE_TEST_FAIL_BOOTSTRAP:-0}" != "1" ] || exit 73
    receipt=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--receipt-file" ]; then receipt=$2; break; fi
      shift
    done
    [ -n "$receipt" ] || exit 74
    mkdir -p "$(dirname "$receipt")"
    printf '%s\n' '{"schema_version":1,"node_id":"node-test"}' > "$receipt"
    ;;
  *" status "*) ;;
  *) exit 75 ;;
esac
SH
chmod 0755 "$artifact"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

case "$(uname -s)" in
  Darwin) platform=macos ;;
  Linux) platform=linux ;;
  *) fail "unsupported test host" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) architecture=aarch64 ;;
  x86_64|amd64) architecture=x86_64 ;;
  *) fail "unsupported test architecture" ;;
esac

# The production manifest builder must produce a detached signature verifiable by
# the same public key embedded into the installers.
built_manifest="$temporary/built-manifest.json"
python3 "$script_dir/build_release_manifest.py" \
  --version 0.1.0-test \
  --signing-key "$private_key" \
  --output "$built_manifest" \
  --artifact "$platform=$architecture=$artifact=https://releases.example/morphz-edge"
openssl dgst -sha256 -verify "$public_key" -signature "$built_manifest.sig" "$built_manifest" >/dev/null \
  || fail "release manifest signature is not verifiable"

rendered="$temporary/rendered"
sh "$script_dir/render_installers.sh" "$public_key" "$rendered"
grep -q '__MORPHZ_EDGE_RELEASE_PUBLIC_KEY_PEM_B64__' "$rendered/install" \
  && fail "rendered Shell installer still contains its key placeholder"
grep -q '__MORPHZ_EDGE_RELEASE_PUBLIC_KEY_PEM_B64__' "$rendered/install.ps1" \
  && fail "rendered PowerShell installer still contains its key placeholder"

# Use a signed local fixture to exercise installation without network access.
sha=$(sha256_file "$artifact")
size=$(wc -c < "$artifact" | tr -d ' ')
manifest="$temporary/manifest.json"
python3 - "$manifest" "$platform" "$architecture" "$artifact" "$sha" "$size" <<'PY'
import json, pathlib, sys
path, platform, architecture, artifact, digest, size = sys.argv[1:]
value = {
    "schema_version": 1,
    "version": "0.1.0-test",
    "published_at": "2026-09-01T00:00:00Z",
    "artifacts": [{
        "platform": platform,
        "architecture": architecture,
        "url": pathlib.Path(artifact).as_uri(),
        "sha256": digest,
        "size_bytes": int(size),
        "archive_format": "raw",
    }],
}
pathlib.Path(path).write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
PY
openssl dgst -sha256 -sign "$private_key" -out "$manifest.sig" "$manifest"

home="$temporary/home"
mkdir -p "$home"
export MORPHZ_EDGE_TEST_ARGUMENT_LOG="$argument_log"
HOME="$home" \
MORPHZ_EDGE_ALLOW_INSECURE_TEST_URLS=1 \
MORPHZ_EDGE_INSTALL_NO_SERVICE=1 \
sh "$rendered/install" \
  --manifest-url "file://$manifest" \
  --server-url http://127.0.0.1:8788 \
  --workspace "$workspace" \
  --code pair_once_only_for_test >/dev/null

[ -x "$home/.local/bin/morphz-edge" ] || fail "binary was not installed"
[ -f "$home/.morphz/edge/bootstrap-receipt.json" ] || fail "bootstrap receipt was not created"
grep -q 'pair_once_only_for_test' "$argument_log" || fail "pairing code did not reach bootstrap"
grep -q 'http://127.0.0.1:8788' "$argument_log" || fail "Edge Server URL did not reach bootstrap"
grep -Fq "$workspace" "$argument_log" || fail "workspace did not reach bootstrap"
grep -q 'pair_once_only_for_test' "$home/.morphz/edge/bootstrap-receipt.json" \
  && fail "pairing code leaked into the persistent receipt"

# A tampered manifest must fail before installing anything.
tampered_home="$temporary/tampered-home"
mkdir -p "$tampered_home"
printf ' ' >> "$manifest"
if HOME="$tampered_home" MORPHZ_EDGE_ALLOW_INSECURE_TEST_URLS=1 MORPHZ_EDGE_INSTALL_NO_SERVICE=1 \
  sh "$rendered/install" --manifest-url "file://$manifest" --server-url http://127.0.0.1:8788 \
  --workspace "$workspace" --code pair_tampered >/dev/null 2>&1; then
  fail "tampered manifest was accepted"
fi
[ ! -e "$tampered_home/.local/bin/morphz-edge" ] || fail "tampered install wrote a binary"

# A failed pairing must restore the previous binary and never register a service.
openssl dgst -sha256 -sign "$private_key" -out "$manifest.sig" "$manifest"
rollback_home="$temporary/rollback-home"
mkdir -p "$rollback_home/.local/bin"
printf '%s\n' '#!/bin/sh' 'exit 0' > "$rollback_home/.local/bin/morphz-edge"
chmod 0755 "$rollback_home/.local/bin/morphz-edge"
previous_sha=$(sha256_file "$rollback_home/.local/bin/morphz-edge")
if HOME="$rollback_home" MORPHZ_EDGE_ALLOW_INSECURE_TEST_URLS=1 MORPHZ_EDGE_INSTALL_NO_SERVICE=1 \
  MORPHZ_EDGE_TEST_FAIL_BOOTSTRAP=1 sh "$rendered/install" \
  --manifest-url "file://$manifest" --server-url http://127.0.0.1:8788 \
  --workspace "$workspace" --code pair_must_rollback >/dev/null 2>&1; then
  fail "failed pairing unexpectedly succeeded"
fi
restored_sha=$(sha256_file "$rollback_home/.local/bin/morphz-edge")
[ "$previous_sha" = "$restored_sha" ] || fail "previous binary was not restored"

printf '%s\n' "edge installer tests passed ($platform/$architecture)"
