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

set -e

BRANCH="${1:-develop}"
REPO_DIR="/root/CoNest"
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
git push origin "$BRANCH"

echo ""
echo "=== Sync complete ==="
echo ""
echo "PR link: https://github.com/zyw02/CoNest/compare/$BRANCH...ralf003:CoNest:$BRANCH"
