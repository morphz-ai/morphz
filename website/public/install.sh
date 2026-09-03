#!/bin/sh
set -eu

repository="${MORPHZ_GITHUB_REPOSITORY:-morphz-ai/morphz}"
version="${MORPHZ_VERSION:-latest}"
install_dir="${MORPHZ_INSTALL_DIR:-${HOME}/.local/bin}"

fail() {
  printf '%s\n' "morphz installer: $*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

case "$(uname -s)" in
  Darwin) platform="macos" ;;
  Linux) platform="linux" ;;
  *) fail "unsupported operating system: $(uname -s)" ;;
esac

case "$(uname -m)" in
  arm64|aarch64) architecture="aarch64" ;;
  x86_64|amd64) architecture="x86_64" ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

case "$platform-$architecture" in
  macos-aarch64|macos-x86_64|linux-x86_64) ;;
  *) fail "no Morphz release is published for $platform/$architecture" ;;
esac

asset="morphz-$platform-$architecture.tar.gz"
if [ -n "${MORPHZ_RELEASE_BASE_URL:-}" ]; then
  release_base="$MORPHZ_RELEASE_BASE_URL"
elif [ "$version" = "latest" ]; then
  release_base="https://github.com/$repository/releases/latest/download"
else
  release_base="https://github.com/$repository/releases/download/$version"
fi

temporary="$(mktemp -d "${TMPDIR:-/tmp}/morphz-install.XXXXXX")"
trap 'rm -rf "$temporary"' EXIT HUP INT TERM

download() {
  source_url="$1"
  destination="$2"
  case "$source_url" in
    https://*) curl --proto '=https' --tlsv1.2 -fsSL "$source_url" -o "$destination" ;;
    *)
      [ -n "${MORPHZ_RELEASE_BASE_URL:-}" ] || fail "release downloads must use HTTPS"
      curl -fsSL "$source_url" -o "$destination"
      ;;
  esac
}

download "$release_base/$asset" "$temporary/$asset"
download "$release_base/$asset.sha256" "$temporary/$asset.sha256"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$temporary" && sha256sum -c "$asset.sha256") >/dev/null
elif command -v shasum >/dev/null 2>&1; then
  (cd "$temporary" && shasum -a 256 -c "$asset.sha256") >/dev/null
else
  fail "sha256sum or shasum is required to verify the release"
fi

mkdir -p "$temporary/unpacked"
tar -xzf "$temporary/$asset" -C "$temporary/unpacked"
[ -f "$temporary/unpacked/morphz" ] || fail "release archive does not contain morphz"

mkdir -p "$install_dir"
install -m 0755 "$temporary/unpacked/morphz" "$install_dir/morphz"
if [ -f "$temporary/unpacked/morphz-edge" ]; then
  install -m 0755 "$temporary/unpacked/morphz-edge" "$install_dir/morphz-edge"
fi

printf '%s\n' "Morphz installed in $install_dir"
case ":${PATH}:" in
  *":$install_dir:"*) printf '%s\n' "Run: morphz setup" ;;
  *)
    printf '%s\n' "Add $install_dir to PATH, then run: morphz setup"
    printf '%s\n' "For zsh:  export PATH=\"$install_dir:\$PATH\""
    ;;
esac
