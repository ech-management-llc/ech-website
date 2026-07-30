# Listings Contract — the seam Foundation Layer takes over

> **Purpose:** `data/listings.json` is the single source of truth for every public listing.
> Today a human or the intake agent writes it. Later Foundation Layer generates it, and after
> that the swarm platform drives Foundation Layer. **The website never gets rebuilt** — only
> the writer of this one file changes.
>
> **Status:** v1.0 contract, live 2026-07-29. Stand-in phase.
> **Pairs with:** `tools/build-listings.js`, `tools/listing-edit.js`, `tools/photo_pipeline.py`

---

## Why the seam is a JSON file and not an API call

The public site is static HTML on GitHub Pages with no build step and no server. That's a
feature: it costs nothing, can't go down, and the SEO work in those pages (canonical tags,
sitemap, real crawlable content) keeps working. If the pages called an API at runtime, Google
would see empty grids.

So the contract is: **something writes `listings.json`, then `build-listings.js` renders static
HTML from it.** Whoever writes the JSON is free to change. Three planned writers:

| Phase | Writer of `listings.json` | Photo host | Status |
|---|---|---|---|
| 0 — stand-in | intake agent (email) + `listing-edit.js` | Supabase `listing-photos` | **current** |
| 1 — FL-native | `GET /api/properties` + `/api/units`, `source: "foundation-layer"` | Supabase (unchanged) | when FL owns the rent roll |
| 2 — swarm | swarm platform → FL → generator | Supabase (unchanged) | later |

Because photos already live in Supabase, phase 1 requires **no photo migration**. That was the
whole reason for choosing Supabase over the website repo.

---

## Field mapping to Foundation Layer

FL's models already carry nearly all of this. `src/models/property.py` reserves
`details` (JSONB) explicitly for "rank, lease, property_tax, **photos**, …".

### Single-family listing → `property`

| `listings.json` | FL field | Notes |
|---|---|---|
| `id` | — | URL slug, stable. Never reuse for a different address. |
| `fl_property_id` | `properties.id` (UUID) | **null today.** Set this when FL becomes the writer — it's the join key. |
| `address` | `properties.address` | Required on both sides. |
| `city`, `state` | `details.city`, `details.state` | FL keeps one flat `address` string; city/state ride in `details`. |
| `status` | `properties.status` | Vocabulary differs — see mapping below. |
| `beds` | `properties.beds` (float) | Direct. |
| `baths` | `properties.baths` (float) | Direct. 1.5 is valid. |
| `sqft` | `properties.sqft` (int) | Direct. |
| `rent` | `units[0].market_rent` | **FL has no rent on `property`** — asking rent lives on the unit. A one-door SFR maps to a single unit. |
| `photos[]` | `details.photos[]` | Array of absolute https URLs, hero first. |
| `note`, `cta`, `badge_label`, `scene`, `order`, `virtual_tour` | `details.listing.*` | Presentation-only. FL should not invent these; carry them through untouched. |

### Multifamily listing → `property` + `units[]`

| `listings.json` | FL field |
|---|---|
| `floor_plans[].beds/baths/sqft` | `units[].beds/baths/sqft` |
| `floor_plans[].rent` | `units[].market_rent` |
| `floor_plans[].status` | `units[].status` |
| `floor_plans[].available_count` | count of units sharing that plan with `status = vacant` |
| `units_available` | derived — never stored independently |
| `all_bills_paid`, `bills_text` | `details.listing.*` |

`listing-edit.js plan` already treats `units_available` and the building badge as **derived**
from the plan rows, so the badge can never contradict the unit list. FL must preserve that: the
rollup is computed, not authored.

### Status vocabulary

| listings.json | FL `property.status` | FL `unit.status` | Public badge |
|---|---|---|---|
| `available` | `listed` | `vacant` | Available (green) |
| `coming_soon` | `rehab` | `rehab` | Coming Soon (green) |
| `leased` | `occupied` | `occupied` | Rented / Leased (red) |
| `inquire` | `listed` | `vacant` | Inquire (grey) |

FL's `unit.status` also allows `down`. A unit that's `down` is **not** publishable — it must not
appear as available. Map `down` to omitting the plan row, not to `available`.

---

## Two rules FL must not break

**1. NULL is not zero.** FL's own doctrine says it (`unit.py`: *"`market_rent = None` must render
as UNKNOWN, never as $0 — the 2.3b false-GREEN lesson"*). The renderer honours this: if `rent` is
null the price line is omitted entirely rather than printing `$0/mo`. A generator that defaults
missing rent to 0 will publish `$0/mo` to the public internet.

**2. Tenant data never crosses the seam.** `listings.json` is public — it ships to GitHub Pages
and is world-readable. It must never carry occupant names, lease dates, ledger balances, or
anything from `occupants` / `leases` / `rent_ledger`. When FL becomes the writer, the generator
reads from `properties` and `units` only, and only fields in the table above.

---

## When FL takes over

1. Backfill `fl_property_id` on all 14 listings (one-time join by address).
2. Write a generator producing `listings.json` from `/api/properties` + `/api/units`, filtered to
   publishable statuses, setting `source: "foundation-layer"`.
3. Diff its output against the hand-maintained file until they match. **Do not cut over on a
   first-run match** — run it shadow-mode for a week, the way TCC shadow-builds market signals.
4. Flip the intake agent from `listing-edit.js` to FL writes (`PATCH /api/properties/{id}`), so
   the phone path updates FL and FL regenerates the site.
5. `build-listings.js` and `photo_pipeline.py` are untouched by all of this. That's the point.

---

## Validation is the contract test

`node tools/build-listings.js --check` exits non-zero if the pages don't match the data, and
refuses to write on any validation error (unknown status, duplicate id, missing rent on an
available listing, a photo URL that isn't https, a `/assets/` photo that isn't on disk).

Wire that into CI and any writer — human, agent, or FL — is held to the same contract.

## Last reviewed

**2026-07-29** — contract written alongside the stand-in build. Renderer verified byte-identical
to the pre-existing hand-built pages across all 14 listings.
