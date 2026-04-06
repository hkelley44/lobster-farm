#!/usr/bin/env bash
set -euo pipefail

# LobsterFarm installer
# Usage: curl -fsSL https://raw.githubusercontent.com/ultim88888888/lobster-farm/main/install.sh | bash

REPO="ultim88888888/lobster-farm"
INSTALL_DIR="$HOME/.lobsterfarm/src"
BIN_DIR="$HOME/.local/bin"

info()  { printf "\033[1;34m==>\033[0m %s\n" "$1"; }
warn()  { printf "\033[1;33m==>\033[0m %s\n" "$1"; }
error() { printf "\033[1;31merror:\033[0m %s\n" "$1" >&2; exit 1; }

# ── Prerequisites ──

info "Checking prerequisites..."

command -v node >/dev/null 2>&1 || error "Node.js not found. Install Node.js 22+ first."

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
[ "$NODE_MAJOR" -ge 22 ] 2>/dev/null || error "Node.js 22+ required (found $(node -v))"

command -v pnpm >/dev/null 2>&1 || {
  warn "pnpm not found — installing via corepack..."
  corepack enable && corepack prepare pnpm@latest --activate
}

command -v claude >/dev/null 2>&1 || warn "Claude Code CLI not found. Install it before running 'lf init'."
command -v op >/dev/null 2>&1    || warn "1Password CLI (op) not found. Install it before running 'lf init'."

# ── Clone ──

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing install at $INSTALL_DIR..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  info "Cloning $REPO..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if command -v gh >/dev/null 2>&1; then
    gh repo clone "$REPO" "$INSTALL_DIR"
  else
    git clone "https://github.com/$REPO.git" "$INSTALL_DIR"
  fi
fi

# ── Build ──

info "Installing dependencies and building..."
cd "$INSTALL_DIR"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
pnpm build

# ── Symlink CLI ──

info "Linking CLI..."
mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/packages/cli/dist/index.js" "$BIN_DIR/lf"
ln -sf "$INSTALL_DIR/packages/cli/dist/index.js" "$BIN_DIR/lobsterfarm"

if ! command -v lf >/dev/null 2>&1; then
  warn "$BIN_DIR is not on your PATH. Add to your shell profile:"
  warn "  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# ── Done ──

printf "\n"
info "LobsterFarm installed successfully."
info "Run 'lf init' to start the setup wizard."
printf "\n"
