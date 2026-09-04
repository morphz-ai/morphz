#!/bin/sh
set -eu

fail() {
  printf '%s\n' "morphz-edge install: $*" >&2
  exit 1
}

code="${MORPHZ_BOOTSTRAP_CODE:-}"
server_url="${MORPHZ_EDGE_SERVER_URL:-}"
workspace="${MORPHZ_EDGE_WORKSPACE:-$(pwd)}"
node_name="${MORPHZ_EDGE_NODE_NAME:-}"
workers="${MORPHZ_EDGE_WORKERS:-}"
full_access=0
manifest_url="${MORPHZ_EDGE_MANIFEST_URL:-https://morphz.ai/edge/releases/manifest.json}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --code) [ "$#" -ge 2 ] || fail "--code requires a value"; code=$2; shift 2 ;;
    --server-url) [ "$#" -ge 2 ] || fail "--server-url requires a value"; server_url=$2; shift 2 ;;
    --workspace) [ "$#" -ge 2 ] || fail "--workspace requires a value"; workspace=$2; shift 2 ;;
    --node-name) [ "$#" -ge 2 ] || fail "--node-name requires a value"; node_name=$2; shift 2 ;;
    --workers) [ "$#" -ge 2 ] || fail "--workers requires a value"; workers=$2; shift 2 ;;
    --manifest-url) [ "$#" -ge 2 ] || fail "--manifest-url requires a value"; manifest_url=$2; shift 2 ;;
    --full-access) full_access=1; shift ;;
    *) fail "unknown option '$1'" ;;
  esac
done

[ -n "$code" ] || fail "a short-lived --code is required"
[ -n "$server_url" ] || fail "--server-url is required"
[ -d "$workspace" ] || fail "workspace '$workspace' is not a directory"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v openssl >/dev/null 2>&1 || fail "openssl is required for release signature verification"
command -v python3 >/dev/null 2>&1 || fail "python3 is required to read the signed release manifest"

case "$manifest_url" in
  https://*) ;;
  file://*) [ "${MORPHZ_EDGE_ALLOW_INSECURE_TEST_URLS:-0}" = "1" ] || fail "manifest URL must use HTTPS" ;;
  *) fail "manifest URL must use HTTPS" ;;
esac
case "$server_url" in
  https://*) ;;
  http://127.0.0.1:*|http://localhost:*)
    [ "${MORPHZ_EDGE_ALLOW_INSECURE_TEST_URLS:-0}" = "1" ] || fail "Edge Server URL must use HTTPS"
    ;;
  *) fail "Edge Server URL must use HTTPS" ;;
esac

os=$(uname -s)
machine=$(uname -m)
case "$os" in
  Darwin) platform=macos ;;
  Linux) platform=linux ;;
  *) fail "unsupported operating system '$os'" ;;
esac
case "$machine" in
  arm64|aarch64) architecture=aarch64 ;;
  x86_64|amd64) architecture=x86_64 ;;
  *) fail "unsupported architecture '$machine'" ;;
esac

temporary=$(mktemp -d "${TMPDIR:-/tmp}/morphz-edge-install.XXXXXX")
cleanup() { rm -rf "$temporary"; }
trap cleanup EXIT HUP INT TERM

manifest="$temporary/manifest.json"
signature="$temporary/manifest.json.sig"
public_key="$temporary/release-public-key.pem"
artifact="$temporary/morphz-edge.tar.gz"
curl -fsSL "$manifest_url" -o "$manifest"
curl -fsSL "${manifest_url}.sig" -o "$signature"

public_key_b64="${MORPHZ_EDGE_RELEASE_PUBLIC_KEY_PEM_B64:-__MORPHZ_EDGE_RELEASE_PUBLIC_KEY_PEM_B64__}"
case "$public_key_b64" in
  __MORPHZ_*) fail "installer has not been rendered with the production release public key" ;;
esac
printf '%s' "$public_key_b64" | openssl base64 -d -A > "$public_key" \
  || fail "release public key is invalid"
openssl dgst -sha256 -verify "$public_key" -signature "$signature" "$manifest" >/dev/null \
  || fail "release manifest signature verification failed"

selection=$(python3 - "$manifest" "$platform" "$architecture" <<'PY'
import json, sys
path, platform, architecture = sys.argv[1:]
with open(path, "r", encoding="utf-8") as handle:
    manifest = json.load(handle)
if manifest.get("schema_version") != 1:
    raise SystemExit("unsupported manifest schema")
matches = [item for item in manifest.get("artifacts", [])
           if item.get("platform") == platform and item.get("architecture") == architecture]
if len(matches) != 1:
    raise SystemExit(f"manifest has {len(matches)} artifacts for {platform}/{architecture}")
item = matches[0]
for field in ("url", "sha256", "size_bytes", "archive_format"):
    if field not in item:
        raise SystemExit(f"artifact is missing {field}")
print(manifest.get("version", ""))
print(item["url"])
print(item["sha256"])
print(item["size_bytes"])
print(item["archive_format"])
PY
) || fail "release manifest does not contain this platform"

version=$(printf '%s\n' "$selection" | sed -n '1p')
artifact_url=$(printf '%s\n' "$selection" | sed -n '2p')
expected_sha=$(printf '%s\n' "$selection" | sed -n '3p')
expected_size=$(printf '%s\n' "$selection" | sed -n '4p')
archive_format=$(printf '%s\n' "$selection" | sed -n '5p')
[ -n "$version" ] || fail "release manifest has no version"
[ "$archive_format" = "tar.gz" ] || fail "unsupported $platform artifact format '$archive_format'"
case "$artifact_url" in
  https://*) ;;
  file://*) [ "${MORPHZ_EDGE_ALLOW_INSECURE_TEST_URLS:-0}" = "1" ] || fail "artifact URL must use HTTPS" ;;
  *) fail "artifact URL must use HTTPS" ;;
esac

curl -fsSL "$artifact_url" -o "$artifact"
actual_size=$(wc -c < "$artifact" | tr -d ' ')
[ "$actual_size" = "$expected_size" ] \
  || fail "download size mismatch (expected $expected_size, received $actual_size)"
if command -v sha256sum >/dev/null 2>&1; then
  actual_sha=$(sha256sum "$artifact" | awk '{print $1}')
else
  actual_sha=$(shasum -a 256 "$artifact" | awk '{print $1}')
fi
[ "$actual_sha" = "$expected_sha" ] || fail "download SHA-256 mismatch"

bundle="$temporary/bundle"
mkdir -p "$bundle"
tar -xzf "$artifact" -C "$bundle"
source_binary="$bundle/morphz-edge"
[ -f "$source_binary" ] || fail "release bundle does not contain morphz-edge"
chmod 0755 "$source_binary"

install_dir="${MORPHZ_EDGE_INSTALL_DIR:-$HOME/.local/bin}"
state_dir="${MORPHZ_EDGE_STATE_DIR:-$HOME/.morphz/edge}"
install_path="$install_dir/morphz-edge"
receipt_path="$state_dir/bootstrap-receipt.json"
mkdir -p "$install_dir" "$state_dir"
backup=""
if [ -e "$install_path" ]; then
  backup="$temporary/morphz-edge.previous"
  cp "$install_path" "$backup"
fi
cp "$source_binary" "$install_path.new"
chmod 0755 "$install_path.new"
mv "$install_path.new" "$install_path"

license_dir="$state_dir/licenses"
mkdir -p "$license_dir"
for legal_entry in LICENSE NOTICE THIRD_PARTY_NOTICES.md THIRD_PARTY_LICENSES_RUST.md dashboard third_party; do
  if [ -e "$bundle/$legal_entry" ]; then
    rm -rf "${license_dir:?}/$legal_entry"
    cp -R "$bundle/$legal_entry" "$license_dir/$legal_entry"
  fi
done

set -- --workspace "$workspace" bootstrap \
  --server-url "$server_url" --pairing-code "$code" \
  --receipt-file "$receipt_path" --json
[ -z "$node_name" ] || set -- "$@" --node-name "$node_name"
[ -z "$workers" ] || set -- "$@" --workers "$workers"
[ "$full_access" -eq 0 ] || set -- "$@" --full-access
if ! "$install_path" "$@" > "$temporary/bootstrap-receipt-output.json"; then
  if [ -n "$backup" ]; then cp "$backup" "$install_path"; else rm -f "$install_path"; fi
  fail "pairing failed; no background service was registered"
fi

log_path="$state_dir/service.log"
if [ "${MORPHZ_EDGE_INSTALL_NO_SERVICE:-0}" = "1" ]; then
  printf '%s\n' "morphz-edge $version paired (service registration skipped by test override)"
  exit 0
fi

if [ "$platform" = "macos" ]; then
  service_path="$HOME/Library/LaunchAgents/com.newvar.morphz.edge.plist"
  mkdir -p "$(dirname "$service_path")"
  python3 - "$service_path" "$install_path" "$receipt_path" "$log_path" <<'PY'
import plistlib, sys
path, binary, receipt, log = sys.argv[1:]
value = {
  "Label": "com.newvar.morphz.edge",
  "ProgramArguments": [binary, "service-run", "--receipt-file", receipt],
  "RunAtLoad": True,
  "KeepAlive": {"SuccessfulExit": False},
  "StandardOutPath": log,
  "StandardErrorPath": log,
  "ProcessType": "Background",
}
with open(path, "wb") as handle:
    plistlib.dump(value, handle, sort_keys=True)
PY
  launchctl bootout "gui/$(id -u)/com.newvar.morphz.edge" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$service_path"
  launchctl kickstart -k "gui/$(id -u)/com.newvar.morphz.edge"
elif command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  service_dir="$HOME/.config/systemd/user"
  service_path="$service_dir/morphz-edge.service"
  mkdir -p "$service_dir"
  python3 - "$service_path" "$install_path" "$receipt_path" <<'PY'
import sys
path, binary, receipt = sys.argv[1:]
def q(value): return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'
unit = "\n".join([
  "[Unit]", "Description=Morphz Edge Node", "After=network-online.target", "Wants=network-online.target", "",
  "[Service]", f"ExecStart={q(binary)} service-run --receipt-file {q(receipt)}",
  "Restart=on-failure", "RestartSec=3", "", "[Install]", "WantedBy=default.target", "",
])
with open(path, "w", encoding="utf-8") as handle: handle.write(unit)
PY
  systemctl --user daemon-reload
  systemctl --user enable --now morphz-edge.service
else
  nohup "$install_path" service-run --receipt-file "$receipt_path" >> "$log_path" 2>&1 &
  printf '%s\n' "$!" > "$state_dir/service.pid"
  printf '%s\n' "warning: systemd --user is unavailable; Edge is running now but cannot be registered for login startup" >&2
fi

"$install_path" status >/dev/null
printf '%s\n' "morphz-edge $version installed, paired, and started"
printf '%s\n' "workspace: $workspace"
printf '%s\n' "log: $log_path"
