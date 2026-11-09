#!/bin/sh
# Install the tracked hooks in .githooks/.
# Safe to run repeatedly. Does nothing outside a Git checkout.
#
# If .git/hooks already has custom (non-sample) hooks, this avoids setting
# core.hooksPath because that would stop those hooks from running. In that
# case it installs commit-msg only when it can do so without overwriting.

cd "$(dirname "$0")/.." 2>/dev/null || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

git_dir=$(git rev-parse --git-dir 2>/dev/null) || exit 0
hooks_dir="$git_dir/hooks"

chmod +x .githooks/* 2>/dev/null || true

has_custom_hooks=false
if [ -d "$hooks_dir" ]; then
  for f in "$hooks_dir"/*; do
    [ -e "$f" ] || continue
    case "$f" in *.sample) continue ;; esac
    # A hook we may have installed ourselves is fine to manage.
    if [ -f "$f" ] && grep -q 'visto-gallery managed hook' "$f" 2>/dev/null; then
      continue
    fi
    if [ -x "$f" ] || [ -f "$f" ]; then
      has_custom_hooks=true
      break
    fi
  done
fi

if [ "$has_custom_hooks" = true ]; then
  target="$hooks_dir/commit-msg"
  if [ ! -e "$target" ]; then
    {
      echo '#!/bin/sh'
      echo '# visto-gallery managed hook'
      echo 'dir=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0'
      echo '[ -x "$dir/.githooks/commit-msg" ] && exec "$dir/.githooks/commit-msg" "$@"'
      echo 'exit 0'
    } > "$target" && chmod +x "$target"
  elif grep -q 'visto-gallery managed hook' "$target" 2>/dev/null; then
    : # already ours
  else
    echo "setup-hooks: .git/hooks has custom hooks; not changing core.hooksPath or $target." >&2
    echo "setup-hooks: add .githooks/commit-msg to your commit-msg hook to strip AI trailers." >&2
  fi
  exit 0
fi

git config core.hooksPath .githooks || exit 0
