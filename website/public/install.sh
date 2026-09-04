#!/bin/sh
set -eu

repository="${MORPHZ_GITHUB_REPOSITORY:-morphz-ai/morphz}"
version="${MORPHZ_VERSION:-latest}"
install_dir="${MORPHZ_INSTALL_DIR:-${HOME}/.local/bin}"

progress() {
  printf '[%s/5] %s\n' "$1" "$2"
}

fail() {
  printf '%s\n' "morphz installer: $*" >&2
  exit 1
}

usage() {
  printf '%s\n' 'Usage: install.sh [setup [SETUP_OPTIONS...]]'
}

post_install_action=""
case "${1:-}" in
  "") ;;
  setup)
    post_install_action="setup"
    shift
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    fail "unknown action: $1"
    ;;
esac

progress 1 "Detecting system"
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
  macos-aarch64|macos-x86_64|linux-aarch64|linux-x86_64) ;;
  *) fail "no Morphz release is published for $platform/$architecture" ;;
esac

if [ "$platform" = "macos" ]; then
  macos_major="$(sw_vers -productVersion 2>/dev/null | cut -d. -f1)"
  case "$macos_major" in
    ''|*[!0-9]*) fail "could not determine the macOS version" ;;
  esac
  [ "$macos_major" -ge 11 ] || fail "Morphz requires macOS 11 or newer"
elif [ "$platform" = "linux" ]; then
  if ! command -v bwrap >/dev/null 2>&1; then
    printf '%s\n' \
      "Warning: Bubblewrap is not installed; Morphz local command execution will stay unavailable." \
      "Install your distribution's bubblewrap package, then run: morphz doctor" >&2
  elif ! bwrap --ro-bind / / --dev /dev --unshare-user --unshare-pid --proc /proc -- /bin/true >/dev/null 2>&1; then
    printf '%s\n' \
      "Warning: Bubblewrap cannot create an unprivileged sandbox on this system." \
      "Ask the system administrator to enable unprivileged user namespaces, then run: morphz doctor" >&2
  fi
fi

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
    https://*) curl --proto '=https' --tlsv1.2 --fail --location --show-error --progress-bar "$source_url" -o "$destination" ;;
    *)
      [ -n "${MORPHZ_RELEASE_BASE_URL:-}" ] || fail "release downloads must use HTTPS"
      curl --fail --location --show-error --progress-bar "$source_url" -o "$destination"
      ;;
  esac
}

progress 2 "Downloading $asset"
download "$release_base/$asset" "$temporary/$asset"
download "$release_base/$asset.sha256" "$temporary/$asset.sha256"

progress 3 "Verifying SHA-256 checksum"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$temporary" && sha256sum -c "$asset.sha256") >/dev/null
elif command -v shasum >/dev/null 2>&1; then
  (cd "$temporary" && shasum -a 256 -c "$asset.sha256") >/dev/null
else
  fail "sha256sum or shasum is required to verify the release"
fi

progress 4 "Installing to $install_dir"
mkdir -p "$temporary/unpacked"
tar -xzf "$temporary/$asset" -C "$temporary/unpacked"
[ -f "$temporary/unpacked/morphz" ] || fail "release archive does not contain morphz"

mkdir -p "$install_dir"
install -m 0755 "$temporary/unpacked/morphz" "$install_dir/morphz"

progress 5 "Configuring the command path"
path_file=""
path_status="available"
case ":${PATH}:" in
  *":$install_dir:"*) ;;
  *)
    path_status="manual"
    if [ "$install_dir" = "${HOME}/.local/bin" ] && [ "${MORPHZ_NO_MODIFY_PATH:-0}" != "1" ]; then
      shell_name="$(basename "${SHELL:-sh}")"
      case "$shell_name" in
        fish)
          path_file="${XDG_CONFIG_HOME:-${HOME}/.config}/fish/conf.d/morphz.fish"
          path_line='fish_add_path --global "$HOME/.local/bin"'
          ;;
        zsh)
          path_file="${HOME}/.zshrc"
          path_line='export PATH="$HOME/.local/bin:$PATH"'
          ;;
        bash)
          if [ "$platform" = "macos" ]; then
            path_file="${HOME}/.bash_profile"
          else
            path_file="${HOME}/.bashrc"
          fi
          path_line='export PATH="$HOME/.local/bin:$PATH"'
          ;;
        *)
          path_file="${HOME}/.profile"
          path_line='export PATH="$HOME/.local/bin:$PATH"'
          ;;
      esac

      mkdir -p "$(dirname "$path_file")"
      if [ ! -f "$path_file" ] || ! grep -F "$path_line" "$path_file" >/dev/null 2>&1; then
        printf '\n%s\n%s\n' '# Added by the Morphz installer' "$path_line" >> "$path_file"
      fi
      path_status="configured"
    fi
    ;;
esac

printf '\n%s\n' "Morphz is installed."
case "$path_status" in
  available)
    if [ -z "$post_install_action" ]; then
      printf '%s\n' "Run now: morphz setup"
    fi
    ;;
  configured)
    printf '%s\n' "Added $install_dir to PATH in $path_file"
    if [ -z "$post_install_action" ]; then
      printf '%s\n' "Run now: $install_dir/morphz setup"
    fi
    printf '%s\n' "New terminals can run: morphz setup"
    ;;
  manual)
    printf '%s\n' "$install_dir is not on PATH."
    if [ -z "$post_install_action" ]; then
      printf '%s\n' "Run now: $install_dir/morphz setup"
    fi
    printf '%s\n' "Add this directory to your shell PATH for future terminals."
    ;;
esac

if [ "$post_install_action" = "setup" ]; then
  no_open_requested=0
  for setup_option in "$@"; do
    case "$setup_option" in
      --no-open|--no-open=true) no_open_requested=1 ;;
    esac
  done
  if ( : </dev/tty ) 2>/dev/null; then
    printf '\n%s\n' "Starting Morphz Setup"
    "$install_dir/morphz" setup "$@" </dev/tty
  elif [ "$no_open_requested" = "1" ]; then
    printf '\n%s\n' "Starting Morphz Setup"
    "$install_dir/morphz" setup "$@"
  else
    printf '\n%s\n' \
      "Morphz is installed, but Setup was not started because no interactive terminal is available." \
      "Run from an interactive terminal: morphz setup --tui"
  fi
fi
