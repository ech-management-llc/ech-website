#!/usr/bin/env bash
#
# bootstrap-publish.sh — ONE-TIME publish of the listing pipeline to main.
#
# Run once from the repo root, on the machine that has GitHub push credentials:
#
#     bash tools/bootstrap-publish.sh --dry-run    # show exactly what would happen
#     bash tools/bootstrap-publish.sh              # do it
#
# Order matters: the pipeline is committed on the current feature branch FIRST, then that
# branch is merged into main in a single merge. That avoids stashing across a branch switch
# (which can conflict on line endings) and keeps your July 19 nav commit's real history.
#
# What ends up on main:
#   - 66f3873  nav dropdown + footer Privacy/Terms on all pages + FL consent form  (yours, July 19)
#   - <new>    the listing pipeline: markers, data/, tools/, docs/, photo CSS, .gitattributes
#
# After this runs, phone-driven listing updates work and everything downstream is automated.

set -euo pipefail

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
run() {
  if [[ $DRY == 1 ]]; then printf '  would run: %s\n' "$*"; else printf '  + %s\n' "$*"; "$@"; fi
}

cd "$(dirname "$0")/.."
say "Repo: $(pwd)"

# ---------------------------------------------------------------- pre-flight

say "Pre-flight"

[[ -f data/listings.json ]] || { echo "  ✗ data/listings.json missing — wrong directory?" >&2; exit 1; }
command -v node >/dev/null || { echo "  ✗ node not found (needed to verify pages match data)" >&2; exit 1; }

if ! node tools/build-listings.js --check >/dev/null 2>&1; then
  echo "  ✗ pages are out of date. Run: node tools/build-listings.js" >&2; exit 1
fi
echo "  ✓ pages match data/listings.json"

[[ -f .gitattributes ]] || { echo "  ✗ .gitattributes missing — CRLF noise would be published" >&2; exit 1; }
echo "  ✓ .gitattributes present (LF pinned)"

git remote get-url origin >/dev/null || { echo "  ✗ no 'origin' remote" >&2; exit 1; }
echo "  ✓ origin: $(git remote get-url origin)"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "  ✓ current branch: $BRANCH"
if [[ "$BRANCH" == "main" ]]; then
  echo "  note: already on main — the merge step will be skipped, pipeline commits directly."
fi

git fetch origin main --quiet
echo "  ✓ fetched origin/main"

# ---------------------------------------------------------------- step 1: commit the pipeline

say "Step 1 — commit the listing pipeline on $BRANCH"

if [[ -z "$(git status --porcelain)" ]]; then
  echo "  nothing to commit — pipeline already committed?"
  SKIP_COMMIT=1
else
  SKIP_COMMIT=0
  echo "  staging:"
  git status --short | sed 's/^/    /'
fi

if [[ $SKIP_COMMIT == 0 ]]; then
  run git add -A
  if [[ $DRY == 1 ]]; then
    echo "  would commit the above"
  else
    git commit -q -F - <<'MSG'
listings: data-driven pipeline — listings.json is the source of truth

The two rental pages are now generated from data/listings.json by
tools/build-listings.js, between LISTINGS:START/END markers. Rendering was
verified byte-identical to the previous hand-built pages across all 14
listings, so this changes no visible output.

- data/listings.json  all 14 listings; the schema Foundation Layer takes over later
- data/scenes.json    the inline SVG fallback art, extracted verbatim
- tools/              render script, edit CLI, photo upload pipeline
- docs/               FL handoff contract + phone workflow reference
- styles.css          photo + thumbnail styles for listings with real photos
- .gitattributes      pin LF; the Windows working copy was rewriting every text
                      file as CRLF, showing 11 files "modified" with no real
                      change. This commit also normalizes those files once.

Photos live in the Supabase listing-photos public bucket, not in this repo: the
GitHub contents API stores binary as text, so a pushed JPEG arrives corrupt.
Verified by probe. The pipeline also strips EXIF/GPS before publishing, since
phone photos tag each property's coordinates.

See docs/FL_LISTINGS_CONTRACT.md for how this hands off to Foundation Layer.
MSG
    echo "  ✓ committed $(git rev-parse --short HEAD)"
  fi
fi

# ---------------------------------------------------------------- step 2: merge to main

if [[ "$BRANCH" != "main" ]]; then
  say "Step 2 — merge $BRANCH into main"
  echo "  bringing across:"
  git log --format='    %h %s' origin/main.."$BRANCH" 2>/dev/null | sed 's/^/  /' || true

  run git checkout main
  run git pull --ff-only origin main
  run git merge --no-ff "$BRANCH" -m "Merge $BRANCH: nav rollout + consent form + data-driven listing pipeline"
else
  say "Step 2 — skipped (already on main)"
fi

# ---------------------------------------------------------------- step 3: verify then push

say "Step 3 — verify the merged tree still builds, then push"

if [[ $DRY == 0 ]]; then
  node tools/build-listings.js --check || {
    echo "  ✗ merged tree does not match listings.json — NOT pushing." >&2
    echo "    Run: node tools/build-listings.js  then commit and re-run." >&2
    exit 1
  }
  echo "  ✓ merged tree verified"
else
  echo "  would verify: node tools/build-listings.js --check"
fi

run git push origin main

# ---------------------------------------------------------------- done

say "Done"
if [[ $DRY == 1 ]]; then
  echo "  Dry run only — nothing changed. Re-run without --dry-run to publish."
else
  echo "  Live in about a minute:  https://echmanagement.services"
  echo ""
  echo "  Clean up my leftover probe branch:"
  echo "    git push origin --delete tars/encoding-probe"
  echo ""
  echo "  From here on it's automated. Email yourself:"
  echo "    LISTING: 124 Pierce leased"
  echo "  Photos: share to the Google Drive folder ECH_LISTING_PHOTOS"
fi
