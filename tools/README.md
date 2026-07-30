# Listing tools

Three small tools. `data/listings.json` is the source of truth; the HTML is generated.

**Never hand-edit the listing cards in the HTML pages.** They live between
`<!-- LISTINGS:START -->` and `<!-- LISTINGS:END -->` and get overwritten on every build.

```
data/listings.json  ──build-listings.js──▶  the two rental pages (static HTML)
data/scenes.json    ──┘                     (SVG fallback art, one per listing)
```

---

## build-listings.js — render

```bash
node tools/build-listings.js          # regenerate both pages
node tools/build-listings.js --check  # exit 1 if pages are stale (use in CI / pre-commit)
```

Validates before writing anything. On any error it writes nothing and lists every problem —
unknown status, duplicate id, an available listing with no rent, a photo that isn't reachable.

A listing with `photos[]` renders real `<img>` tags (hero + thumbnail strip). With no photos it
falls back to its inline SVG scene from `scenes.json`, so a card is never an empty grey box.

## listing-edit.js — change the data

```bash
node tools/listing-edit.js list                                   # what's on the site now
node tools/listing-edit.js show 124-pierce-dr

node tools/listing-edit.js set 124-pierce-dr --status leased       # flips badge, note, CTA, art
node tools/listing-edit.js set 124-pierce-dr --rent 1450
node tools/listing-edit.js set 124-pierce-dr --status available --rent 1450 --sqft 1100

node tools/listing-edit.js plan 13074-state-hwy-198 1 --status leased   # multifamily floor plan
node tools/listing-edit.js plan 412-438-lc-way 1 --count 3

node tools/listing-edit.js photos 124-pierce-dr --add-url https://...   # from photo_pipeline
node tools/listing-edit.js photos 124-pierce-dr --first 02.jpg          # promote to hero
node tools/listing-edit.js photos 124-pierce-dr --clear                 # back to SVG art

node tools/listing-edit.js add 900-new-st --page single-family \
    --address "900 New St" --city Athens --beds 3 --baths 2 --sqft 1200 --rent 1650
node tools/listing-edit.js remove 900-new-st
node tools/listing-edit.js reorder 124-pierce-dr 1
```

`--status` cascades sensibly: leasing a home also sets the note to "Currently leased", drops the
CTA and virtual tour, swaps to leased artwork, and greys the price. Anything you pass explicitly
wins over the default. Bad input is refused, never guessed.

For multifamily, `plan` recomputes the building's badge and available-unit count from the plan
rows, so the badge can't contradict the unit list.

## photo_pipeline.py — get photos onto the CDN

```bash
python3 tools/photo_pipeline.py 124-pierce-dr ~/photos/IMG_4471.jpg ~/photos/IMG_4472.jpg
python3 tools/photo_pipeline.py 124-pierce-dr /path/to/folder/     # whole folder
python3 tools/photo_pipeline.py --list 124-pierce-dr
python3 tools/photo_pipeline.py --delete 124-pierce-dr 02.jpg
```

Resizes to 1600px, re-encodes as progressive JPEG (~150-350 KB), **strips EXIF including GPS**,
uploads to the Supabase `listing-photos` public bucket, verifies the URL reads 200 without auth,
and prints public URLs to stdout — pipe them into `listing-edit.js --add-url`.

Phone photos tag the property's GPS coordinates. Stripping that is not optional.

Credentials read from `foundation-layer/.env` (`SUPABASE_URL`, `SUPABASE_SECRET_KEY`) or the
environment. No secrets live in this repo.

---

## Full update, start to finish

```bash
URLS=$(python3 tools/photo_pipeline.py 102-remington ~/Downloads/remington/*.jpg)
node tools/listing-edit.js photos 102-remington --add-url $URLS
node tools/listing-edit.js set 102-remington --status available --rent 1900
node tools/build-listings.js
# then commit data/listings.json + the two HTML pages
```

## Why photos don't live in this repo

The GitHub connector used by the automation encodes file content as text, so a pushed JPEG
arrives corrupt (verified 2026-07-29 — base64 input was stored as literal base64 characters).
Text pushes fine, binary does not. Photos therefore go to Supabase, which is also where
Foundation Layer will want them — so there's no migration later. See
`docs/FL_LISTINGS_CONTRACT.md`.

## Gotcha: line endings

`.gitattributes` pins LF. Without it the Windows working copy rewrites every text file with CRLF
and `git status` shows a dozen phantom "modified" files. If you see that again, check
`.gitattributes` is still present.
