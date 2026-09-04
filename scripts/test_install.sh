#!/bin/sh
set -eu

repository_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
temporary="$(mktemp -d "${TMPDIR:-/tmp}/morphz-install-test.XXXXXX")"
test_stage="initialization"

cleanup() {
  status="$?"
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ]; then
    printf '%s\n' "installer test failed during: $test_stage" >&2
    for output in "$temporary"/*-output; do
      [ -f "$output" ] || continue
      printf '\n--- %s ---\n' "$(basename "$output")" >&2
      sed -n '1,240p' "$output" >&2
    done
  fi
  rm -rf "$temporary"
  exit "$status"
}

trap cleanup EXIT
trap 'exit 1' HUP INT TERM

test_stage="release matrix contract"
grep -F 'linux-aarch64' "$repository_root/scripts/install.sh" >/dev/null
grep -F 'aarch64-unknown-linux-gnu' "$repository_root/.github/workflows/release.yml" >/dev/null

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
mkdir -p "$temporary/release" "$temporary/arm-release" "$temporary/bundle" "$temporary/bin" "$temporary/home" "$temporary/mock-bin"
printf '%s\n' '#!/bin/sh' 'printf "%s" "morphz installer fixture"' 'for argument in "$@"; do printf " %s" "$argument"; done' 'printf "\n"' > "$temporary/bundle/morphz"
chmod 0755 "$temporary/bundle/morphz"
tar -czf "$temporary/release/$asset" -C "$temporary/bundle" morphz
tar -czf "$temporary/arm-release/morphz-linux-aarch64.tar.gz" -C "$temporary/bundle" morphz

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$temporary/release" && sha256sum "$asset" > "$asset.sha256")
  (cd "$temporary/arm-release" && sha256sum morphz-linux-aarch64.tar.gz > morphz-linux-aarch64.tar.gz.sha256)
else
  (cd "$temporary/release" && shasum -a 256 "$asset" > "$asset.sha256")
  (cd "$temporary/arm-release" && shasum -a 256 morphz-linux-aarch64.tar.gz > morphz-linux-aarch64.tar.gz.sha256)
fi

printf '%s\n' \
  '#!/bin/sh' \
  'case "${1:-}" in' \
  '  -s) printf "%s\n" Linux ;;' \
  '  -m) printf "%s\n" aarch64 ;;' \
  '  *) exit 1 ;;' \
  'esac' > "$temporary/mock-bin/uname"
chmod 0755 "$temporary/mock-bin/uname"

test_stage="Linux ARM64 installation"
PATH="$temporary/mock-bin:$PATH" \
MORPHZ_INSTALL_DIR="$temporary/arm-bin" \
MORPHZ_RELEASE_BASE_URL="file://$temporary/arm-release" \
  sh "$repository_root/scripts/install.sh" >"$temporary/arm-output" 2>&1

[ -x "$temporary/arm-bin/morphz" ]
grep -F '[2/5] Downloading morphz-linux-aarch64.tar.gz' "$temporary/arm-output" >/dev/null

mkdir -p "$temporary/legacy-mac-bin"
printf '%s\n' \
  '#!/bin/sh' \
  'case "${1:-}" in' \
  '  -s) printf "%s\\n" Darwin ;;' \
  '  -m) printf "%s\\n" x86_64 ;;' \
  '  *) exit 1 ;;' \
  'esac' > "$temporary/legacy-mac-bin/uname"
printf '%s\n' '#!/bin/sh' 'printf "%s\\n" 10.15.7' > "$temporary/legacy-mac-bin/sw_vers"
chmod 0755 "$temporary/legacy-mac-bin/uname" "$temporary/legacy-mac-bin/sw_vers"

test_stage="legacy macOS rejection"
if PATH="$temporary/legacy-mac-bin:$PATH" \
  MORPHZ_RELEASE_BASE_URL="file://$temporary/release" \
  sh "$repository_root/scripts/install.sh" >"$temporary/legacy-mac-output" 2>&1; then
  printf '%s\n' 'installer accepted an unsupported macOS version' >&2
  exit 1
fi
grep -F 'Morphz requires macOS 11 or newer' "$temporary/legacy-mac-output" >/dev/null

test_stage="custom install directory"
MORPHZ_INSTALL_DIR="$temporary/bin" \
MORPHZ_RELEASE_BASE_URL="file://$temporary/release" \
  sh "$repository_root/scripts/install.sh" >"$temporary/custom-output" 2>&1

[ -x "$temporary/bin/morphz" ]
[ ! -e "$temporary/bin/morphz-edge" ]
[ "$("$temporary/bin/morphz")" = "morphz installer fixture" ]
grep -F '[1/5] Detecting system' "$temporary/custom-output" >/dev/null
grep -F '[2/5] Downloading' "$temporary/custom-output" >/dev/null
grep -F '[3/5] Verifying SHA-256 checksum' "$temporary/custom-output" >/dev/null
grep -F '[4/5] Installing to' "$temporary/custom-output" >/dev/null
grep -F '[5/5] Configuring the command path' "$temporary/custom-output" >/dev/null
grep -F "Run now: $temporary/bin/morphz setup" "$temporary/custom-output" >/dev/null

test_stage="fish PATH configuration"
HOME="$temporary/home" \
SHELL="/opt/homebrew/bin/fish" \
PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
MORPHZ_RELEASE_BASE_URL="file://$temporary/release" \
  sh "$repository_root/scripts/install.sh" >"$temporary/fish-output" 2>&1

[ -x "$temporary/home/.local/bin/morphz" ]
fish_config="$temporary/home/.config/fish/conf.d/morphz.fish"
[ -f "$fish_config" ]
grep -F 'fish_add_path --global "$HOME/.local/bin"' "$fish_config" >/dev/null
grep -F "Added $temporary/home/.local/bin to PATH in $fish_config" "$temporary/fish-output" >/dev/null
grep -F "Run now: $temporary/home/.local/bin/morphz setup" "$temporary/fish-output" >/dev/null

test_stage="idempotent fish PATH configuration"
HOME="$temporary/home" \
SHELL="/opt/homebrew/bin/fish" \
PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
MORPHZ_RELEASE_BASE_URL="file://$temporary/release" \
  sh "$repository_root/scripts/install.sh" >/dev/null 2>&1

[ "$(grep -cF 'fish_add_path --global "$HOME/.local/bin"' "$fish_config")" -eq 1 ]

test_stage="explicit headless setup"
MORPHZ_INSTALL_DIR="$temporary/setup-bin" \
MORPHZ_RELEASE_BASE_URL="file://$temporary/release" \
  sh "$repository_root/scripts/install.sh" setup --no-open >"$temporary/setup-output" 2>&1

grep -F 'Starting Morphz Setup' "$temporary/setup-output" >/dev/null
grep -F 'morphz installer fixture setup --no-open' "$temporary/setup-output" >/dev/null
if grep -F 'Run now:' "$temporary/setup-output" >/dev/null; then
  printf '%s\n' 'installer printed a redundant command before starting setup' >&2
  exit 1
fi

test_stage="setup without an interactive terminal"
if command -v setsid >/dev/null 2>&1; then
  env \
    MORPHZ_INSTALL_DIR="$temporary/noninteractive-setup-bin" \
    MORPHZ_RELEASE_BASE_URL="file://$temporary/release" \
    setsid sh "$repository_root/scripts/install.sh" setup \
      >"$temporary/noninteractive-setup-output" 2>&1
else
  MORPHZ_INSTALL_DIR="$temporary/noninteractive-setup-bin" \
  MORPHZ_RELEASE_BASE_URL="file://$temporary/release" \
    sh "$repository_root/scripts/install.sh" setup \
      >"$temporary/noninteractive-setup-output" 2>&1
fi

grep -F 'Setup was not started because no interactive terminal is available' \
  "$temporary/noninteractive-setup-output" >/dev/null
if grep -F 'morphz installer fixture setup' "$temporary/noninteractive-setup-output" >/dev/null; then
  printf '%s\n' 'installer started interactive Setup without a terminal' >&2
  exit 1
fi

test_stage="unsupported action rejection"
if MORPHZ_RELEASE_BASE_URL="file://$temporary/release" \
  sh "$repository_root/scripts/install.sh" unsupported >"$temporary/unsupported-output" 2>&1; then
  printf '%s\n' 'installer accepted an unsupported action' >&2
  exit 1
fi
grep -F 'morphz installer: unknown action: unsupported' "$temporary/unsupported-output" >/dev/null

test_posix_profile() {
  shell_name="$1"
  profile_name="$2"
  test_stage="$shell_name PATH configuration"
  test_home="$temporary/home-$shell_name"
  mkdir -p "$test_home"

  HOME="$test_home" \
  SHELL="/bin/$shell_name" \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  MORPHZ_RELEASE_BASE_URL="file://$temporary/release" \
    sh "$repository_root/scripts/install.sh" >"$temporary/$shell_name-output" 2>&1

  profile="$test_home/$profile_name"
  [ -x "$test_home/.local/bin/morphz" ]
  [ -f "$profile" ]
  grep -F 'export PATH="$HOME/.local/bin:$PATH"' "$profile" >/dev/null
  grep -F "Added $test_home/.local/bin to PATH in $profile" "$temporary/$shell_name-output" >/dev/null

  HOME="$test_home" PATH="/usr/bin:/bin:/usr/sbin:/sbin" sh -c '. "$1"; command -v morphz' sh "$profile" \
    | grep -F "$test_home/.local/bin/morphz" >/dev/null
}

test_posix_profile zsh .zshrc
if [ "$platform" = "macos" ]; then
  test_posix_profile bash .bash_profile
else
  test_posix_profile bash .bashrc
fi
test_posix_profile sh .profile
