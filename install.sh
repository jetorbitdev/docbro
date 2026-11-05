#!/bin/bash
# Installs the latest DocBro from GitHub Releases on macOS or Linux.
#   curl -fsSL https://raw.githubusercontent.com/jetorbitdev/docbro/main/install.sh | bash
#
# macOS: copies DocBro.app from the .dmg into /Applications (override with INSTALL_DIR=...).
#   Files downloaded with curl aren't quarantined, so the app opens without the
#   Gatekeeper "Open Anyway" step.
# Linux: installs the .deb with apt, or the .rpm with dnf/zypper. On other distributions
#   it puts the .AppImage in ~/.local/bin/docbro and adds a menu entry.
#
# Each download is checked against the SHA-256 digest GitHub records for the asset.
set -euo pipefail

REPO="jetorbitdev/docbro"
API="https://api.github.com/repos/$REPO/releases/latest"

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "DocBro's installer needs '$1', which isn't installed."; }
need curl

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Lists the latest release's assets as "name<TAB>sha256<TAB>url", one per line. The API
# prints one field per line, and an asset's digest comes before its download URL.
list_assets() {
  curl -fsSL -H "Accept: application/vnd.github+json" "$API" \
    || die "Couldn't reach GitHub, or DocBro has no published release yet."
}
ASSETS="$(list_assets | awk -F'"' '
  /^ *"name": /                 { name = $4; digest = "" }
  /^ *"digest": "sha256:/       { digest = substr($4, 8) }
  /^ *"browser_download_url": / { print name "\t" digest "\t" $4 }
')"
[[ -n "$ASSETS" ]] || die "The latest DocBro release has no files to install."

# Picks the first asset whose name matches one of the given regexes, in order.
pick() {
  local re
  for re in "$@"; do
    local line
    line="$(printf '%s\n' "$ASSETS" | awk -F'\t' -v re="$re" '$1 ~ re { print; exit }')"
    [[ -n "$line" ]] && { printf '%s\n' "$line"; return 0; }
  done
  return 1
}

# Downloads an asset line from pick() to $TMP and prints the file path.
fetch() {
  local name digest url file actual
  IFS=$'\t' read -r name digest url <<<"$1"
  file="$TMP/$name"
  say "⬇️  Downloading ${name}…" >&2
  curl -fSL --progress-bar -o "$file" "$url"
  if [[ -n "$digest" ]]; then
    say "🔐 Verifying checksum…" >&2
    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "$file" | awk '{print $1}')"
    else
      actual="$(shasum -a 256 "$file" | awk '{print $1}')"
    fi
    [[ "$actual" == "$digest" ]] || die "Checksum mismatch for $name, aborting."
  else
    say "⚠️  GitHub has no checksum for $name, skipping verification." >&2
  fi
  printf '%s\n' "$file"
}

sudo_if_needed() {
  if [[ $EUID -eq 0 ]]; then "$@"; else
    command -v sudo >/dev/null 2>&1 || die "Installing needs root, and sudo isn't available."
    sudo "$@"
  fi
}

install_macos() {
  local arch asset dmg dest app
  case "$(uname -m)" in
    arm64) arch="aarch64" ;;
    x86_64) arch="x64" ;;
    *) die "Unsupported Mac architecture: $(uname -m)" ;;
  esac
  asset="$(pick "_${arch}\\.dmg\$" "_universal\\.dmg\$")" \
    || die "The latest release has no .dmg for this Mac ($arch). Build from source: https://github.com/$REPO#build-from-source"
  dmg="$(fetch "$asset")"

  MNT="$TMP/mnt"
  mkdir -p "$MNT"
  hdiutil attach "$dmg" -nobrowse -readonly -quiet -mountpoint "$MNT"
  trap 'hdiutil detach "$MNT" -quiet >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
  [[ -d "$MNT/DocBro.app" ]] || die "The .dmg doesn't contain DocBro.app."

  dest="${INSTALL_DIR:-/Applications}"
  app="$dest/DocBro.app"
  mkdir -p "$dest" 2>/dev/null || true
  local SUDO=""
  if [[ ! -w "$dest" ]] || { [[ -e "$app" ]] && [[ ! -w "$app" ]]; }; then
    SUDO="sudo"
    say "🔑 Admin password needed to write to $dest"
  fi

  osascript -e 'quit app "DocBro"' >/dev/null 2>&1 || true
  $SUDO mkdir -p "$dest"
  $SUDO rm -rf "$app"
  $SUDO ditto "$MNT/DocBro.app" "$app"
  $SUDO xattr -dr com.apple.quarantine "$app" 2>/dev/null || true

  say "✅ Installed to $app"
  open "$app"
}

install_linux_appimage() {
  local asset file bin apps
  asset="$(pick "_amd64\\.AppImage\$")" || die "The latest release has no .AppImage."
  file="$(fetch "$asset")"
  bin="$HOME/.local/bin"
  apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$bin" "$apps"
  install -m 755 "$file" "$bin/docbro"
  cat >"$apps/docbro.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=DocBro
Comment=Word and Markdown editor
Exec=$bin/docbro %f
Terminal=false
Categories=Office;
MimeType=application/vnd.openxmlformats-officedocument.wordprocessingml.document;text/markdown;
EOF
  say "✅ Installed to $bin/docbro"
  case ":$PATH:" in *":$bin:"*) ;; *) say "   Add $bin to your PATH to run 'docbro' from a terminal." ;; esac
  say "   AppImages need FUSE. If DocBro doesn't start, install libfuse2 (or fuse2) from your distribution."
}

install_linux() {
  local asset file
  [[ "$(uname -m)" == "x86_64" ]] || die "DocBro's Linux builds are x86_64 only. Build from source: https://github.com/$REPO#linux"

  if command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then
    asset="$(pick "_amd64\\.deb\$")" || { install_linux_appimage; return; }
    file="$(fetch "$asset")"
    say "🔑 Installing with apt (may ask for your password)…"
    sudo_if_needed apt-get install -y "$file"
  elif command -v dnf >/dev/null 2>&1 || command -v zypper >/dev/null 2>&1; then
    asset="$(pick "\\.x86_64\\.rpm\$")" || { install_linux_appimage; return; }
    file="$(fetch "$asset")"
    say "🔑 Installing the .rpm (may ask for your password)…"
    if command -v dnf >/dev/null 2>&1; then
      sudo_if_needed dnf install -y "$file"
    else
      sudo_if_needed zypper --non-interactive install --allow-unsigned-rpm "$file"
    fi
  else
    install_linux_appimage
    return
  fi
  say "✅ Installed DocBro. Open it from your applications menu, or run 'docbro'."
}

case "$(uname -s)" in
  Darwin) install_macos ;;
  Linux) install_linux ;;
  *) die "This installer is for macOS and Linux. On Windows, run in PowerShell:
  irm https://raw.githubusercontent.com/$REPO/main/install.ps1 | iex" ;;
esac
