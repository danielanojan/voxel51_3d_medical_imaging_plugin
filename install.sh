#!/usr/bin/env bash
# Install @daniel/nifti-slice-viewer and/or @daniel/nifti-3d-viewer
# into the FiftyOne plugins directory.
#
# Usage:
#   ./install.sh               # install both plugins
#   ./install.sh slice-viewer  # install only nifti-slice-viewer
#   ./install.sh 3d-viewer     # install only nifti-3d-viewer
#
# Requires: Python + FiftyOne installed in the active environment.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve FiftyOne plugins directory
PLUGINS_DIR=$(python - <<'EOF'
import fiftyone as fo
print(fo.config.plugins_dir)
EOF
)

if [ -z "$PLUGINS_DIR" ]; then
  echo "ERROR: could not determine FiftyOne plugins directory." >&2
  exit 1
fi

INSTALL_ROOT="$PLUGINS_DIR/@daniel"
mkdir -p "$INSTALL_ROOT"

install_plugin() {
  local name="$1"   # e.g. nifti-slice-viewer
  local src="$SCRIPT_DIR/$name"

  if [ ! -d "$src" ]; then
    echo "ERROR: plugin source not found: $src" >&2
    exit 1
  fi

  if [ ! -f "$src/dist/index.umd.js" ]; then
    echo "ERROR: $name/dist/index.umd.js not found." >&2
    echo "  Build first:" >&2
    echo "    cd $src" >&2
    echo "    FIFTYONE_DIR=\$(pwd)/../../.. yarn install && FIFTYONE_DIR=\$(pwd)/../../.. yarn build" >&2
    exit 1
  fi

  local dest="$INSTALL_ROOT/$name"
  echo "Installing $name → $dest"
  rm -rf "$dest"
  cp -r "$src" "$dest"
  echo "  Done."
}

TARGET="${1:-both}"

case "$TARGET" in
  slice-viewer)
    install_plugin nifti-slice-viewer
    ;;
  3d-viewer)
    install_plugin nifti-3d-viewer
    ;;
  both|"")
    install_plugin nifti-slice-viewer
    install_plugin nifti-3d-viewer
    ;;
  *)
    echo "Unknown target: $TARGET"
    echo "Usage: $0 [slice-viewer|3d-viewer|both]"
    exit 1
    ;;
esac

echo ""
echo "Installed plugins:"
python - <<'EOF'
import fiftyone.plugins as fop
for p in fop.list_plugins():
    if "@daniel" in p.name:
        print(f"  {p.name} v{p.version}  →  {p.directory}")
EOF
