#!/bin/sh
set -eu

[ "$#" -eq 2 ] || {
  printf '%s\n' "usage: $0 RELEASE_PUBLIC_KEY_PEM OUTPUT_DIRECTORY" >&2
  exit 2
}
public_key=$1
output=$2
[ -f "$public_key" ] || { printf '%s\n' "public key not found: $public_key" >&2; exit 2; }
mkdir -p "$output"
key_info=$(openssl ec -pubin -in "$public_key" -text -noout 2>&1) || {
  printf '%s\n' "release public key must be a P-256 EC public key" >&2
  exit 2
}
case "$key_info" in
  *"ASN1 OID: prime256v1"*) ;;
  *) printf '%s\n' "release public key must use P-256 (prime256v1)" >&2; exit 2 ;;
esac
key_b64=$(openssl base64 -A -in "$public_key")
python3 - "$key_b64" "$output" "$(dirname "$0")" <<'PY'
import pathlib, sys
key, output_text, source_text = sys.argv[1:]
output = pathlib.Path(output_text)
source = pathlib.Path(source_text)
placeholder = "__MORPHZ_EDGE_RELEASE_PUBLIC_KEY_PEM_B64__"
for name, target in (("install.sh", "install"), ("install.ps1", "install.ps1")):
    content = (source / name).read_text(encoding="utf-8")
    if content.count(placeholder) != 1:
        raise SystemExit(f"{name} does not contain exactly one public-key placeholder")
    path = output / target
    path.write_text(content.replace(placeholder, key), encoding="utf-8")
    path.chmod(0o755 if name.endswith(".sh") else 0o644)
PY
