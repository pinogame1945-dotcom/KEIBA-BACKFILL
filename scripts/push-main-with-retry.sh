#!/usr/bin/env bash
set -euo pipefail

REMOTE="${1:-origin}"
BRANCH="${2:-main}"
MAX_ATTEMPTS="${GIT_PUSH_MAX_ATTEMPTS:-6}"

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  echo "git push attempt $attempt/$MAX_ATTEMPTS -> $REMOTE/$BRANCH"

  git fetch "$REMOTE" "$BRANCH"

  if ! git rebase "$REMOTE/$BRANCH"; then
    echo "Rebase conflict detected. Refusing automatic conflict resolution."
    git rebase --abort >/dev/null 2>&1 || true
    exit 2
  fi

  set +e
  OUTPUT=$(git push "$REMOTE" "HEAD:$BRANCH" 2>&1)
  STATUS=$?
  set -e

  printf '%s\n' "$OUTPUT"
  if [ "$STATUS" -eq 0 ]; then
    exit 0
  fi

  if ! printf '%s' "$OUTPUT" | grep -Eqi     'cannot lock ref|failed to update ref|fetch first|non-fast-forward|stale info|reference already exists|rejected'; then
    echo "Non-retryable git push failure."
    exit "$STATUS"
  fi

  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    echo "Git push remained contested after $MAX_ATTEMPTS attempts."
    exit "$STATUS"
  fi

  sleep $((attempt * 2))
done
