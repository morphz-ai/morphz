#!/bin/sh
set -eu

repository_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
temporary="$(mktemp -d "${TMPDIR:-/tmp}/morphz-install-test.XXXXXX")"
trap 'rm -rf "$temporary"' EXIT HUP INT TERM

case "$(uname -s)" in
  Darwin) platform="macos" ;;
  Linux) platform="linux" ;;
  *) printf '%s\n' "unsupported installer test platform" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) architecture="aarch64" ;;
  x86_64|amd64) architecture="x86_64" ;;
  *) printf '%s\n' "unsupported installer test architecture" >&2; exit 1 ;;
esac

asset="morphz-$platform-$architecture.tar.gz"
mkdir -p "$temporary/release" "$temporary/bundle" "$temporary/bin"
printf '%s\n' '#!/bin/sh' 'printf "%s\n" "morphz installer fixture"' > "$temporary/bundle/morphz"
printf '%s\n' '#!/bin/sh' 'printf "%s\n" "morphz-edge installer fixture"' > "$temporary/bundle/morphz-edge"
chmod 0755 "$temporary/bundle/morphz" "$temporary/bundle/morphz-edge"
tar -czf "$temporary/release/$asset" -C "$temporary/bundle" morphz morphz-edge

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$temporary/release" && sha256sum "$asset" > "$asset.sha256")
else
  (cd "$temporary/release" && shasum -a 256 "$asset" > "$asset.sha256")
fi

MORPHZ_INSTALL_DIR="$temporary/bin" \
MORPHZ_RELEASE_BASE_URL="file://$temporary/release" \
  sh "$repository_root/scripts/install.sh" >/dev/null

[ -x "$temporary/bin/morphz" ]
[ -x "$temporary/bin/morphz-edge" ]
[ "$("$temporary/bin/morphz")" = "morphz installer fixture" ]
[ "$("$temporary/bin/morphz-edge")" = "morphz-edge installer fixture" ]
