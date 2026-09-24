#!/bin/bash
# CoNest fork sync script — dual-branch workflow
# Usage: bash sync-upstream.sh [branch]
#   branch: develop (default) or main
#
# Branch strategy:
#   - develop: our active development branch, tracks upstream/develop (0.6.x)
#   - main:    stable baseline, tracks upstream/main (0.6.2)
#
# Workflow:
#   1. Fetch upstream and origin
#   2. Rebase our branch on top of upstream
#   3. Push to our fork (origin)
#   4. Create PR link to upstream

set -euo pipefail

BRANCH="${1:-develop}"
if [[ "$BRANCH" != develop && "$BRANCH" != main ]]; then
  echo 'Branch must be develop or main' >&2
  exit 2
fi
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

echo "=== CoNest Fork Sync: $BRANCH ==="
echo ""

# 1. Fetch
echo "[1/5] Fetching upstream and origin..."
git fetch upstream
git fetch origin

# 2. Switch to target branch
CURRENT=$(git branch --show-current)
if [ "$CURRENT" != "$BRANCH" ]; then
  echo "[2/5] Switching from $CURRENT to $BRANCH..."
  git checkout "$BRANCH"
else
  echo "[2/5] Already on $BRANCH"
fi

# Refuse to overwrite fork commits absent from the local branch.
if git show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
  if ! git merge-base --is-ancestor "origin/$BRANCH" "$BRANCH"; then
    echo "origin/$BRANCH contains commits missing from the local branch; integrate them first" >&2
    exit 1
  fi
fi

# 3. Show divergence
echo ""
echo "[3/5] Divergence from upstream/$BRANCH:"
OURS=$(git rev-list --count upstream/$BRANCH..$BRANCH)
THEIRS=$(git rev-list --count $BRANCH..upstream/$BRANCH)
echo "  Our commits ahead: $OURS"
echo "  Upstream commits behind: $THEIRS"
echo ""
if [ "$OURS" -gt 0 ]; then
  echo "Our commits:"
  git log --oneline upstream/$BRANCH..$BRANCH
fi
if [ "$THEIRS" -gt 0 ]; then
  echo ""
  echo "Upstream commits:"
  git log --oneline $BRANCH..upstream/$BRANCH
fi

# 4. Rebase
if [ "$THEIRS" -gt 0 ]; then
  echo ""
  echo "[4/5] Rebasing $OURS commits onto upstream/$BRANCH..."
  git rebase upstream/$BRANCH
else
  echo ""
  echo "[4/5] Up to date with upstream/$BRANCH"
fi

# 5. Push
echo ""
echo "[5/5] Pushing to origin/$BRANCH..."
git push --force-with-lease origin "$BRANCH"

echo ""
echo "=== Sync complete ==="
echo ""
ORIGIN_URL=$(git remote get-url origin)
case "$ORIGIN_URL" in
  git@github.com:*) ORIGIN_REPO="${ORIGIN_URL#git@github.com:}" ;;
  https://github.com/*) ORIGIN_REPO="${ORIGIN_URL#https://github.com/}" ;;
  *) ORIGIN_REPO="" ;;
esac
if [ -n "$ORIGIN_REPO" ]; then
  ORIGIN_REPO="${ORIGIN_REPO%.git}"
  FORK_OWNER="${ORIGIN_REPO%%/*}"
  FORK_NAME="${ORIGIN_REPO#*/}"
  if [ "$FORK_OWNER" != "$FORK_NAME" ]; then
    echo "PR link: https://github.com/zyw02/CoNest/compare/$BRANCH...${FORK_OWNER}:${FORK_NAME}:$BRANCH"
  fi
fi
