# Iris — the instruction contract

> **Iris is an AI employee. She does what the Chief of Staff tells her.**
> Right now there is no Chief, so she reads her own email. When Foundation Layer plugs in, she stops
> reading email and takes orders from TARS instead. **Her capabilities never change — only where her
> orders come from.**
>
> This document is the seam that makes both futures work.

---

## 1. Why this exists

Website Control needs to be two things at once:

- **A standalone product.** Its own control panel, sellable to a landlord who never buys Foundation
  Layer. Iris lives inside it and takes orders directly.
- **A Foundation Layer capability.** FL's `website-it` tile, owned by Iris, orchestrated by TARS.

The mistake would be building the email parsing *into* Iris. Then plugging into FL means a rewrite.

Instead: **every command source produces the same envelope.** Iris only ever consumes envelopes.
Email is a translator. The control panel is a translator. The Chief of Staff is a translator.
Swapping the source is a config change, not a refactor.

```
COMMAND SOURCES (swappable)              IRIS CORE (fixed)              PUBLISH (fixed)
──────────────────────────               ─────────────────              ───────────────
 standalone  email intake      ─┐
 standalone  control panel     ─┼──→   envelope → listing ops   →   build → commit → Pages
 managed     Chief of Staff    ─┘       (tools/listing-edit.js)      (tools/build-listings.js)
                                                                     (tools/photo_pipeline.py)
```

---

## 2. The instruction envelope

Every source emits this. Iris accepts nothing else.

```json
{
  "envelope_version": "1.0",
  "issued_by":   "email | control_panel | chief_of_staff",
  "issued_at":   "2026-08-03T19:42:00Z",
  "operator":    "manager@echmanagement.services",
  "trace":       "gmail:19fb367d3cb60285",

  "intent": "set_status",
  "target": { "listing_id": "124-pierce-dr" },
  "changes": { "status": "leased" },

  "authorization": {
    "method": "tag | signature | session",
    "verified": true,
    "detail": "#PROCEED present in subject"
  },
  "publish": "auto | propose_only"
}
```

| Field | Meaning |
|---|---|
| `issued_by` | which source produced this. Iris logs it and reports it back. |
| `operator` | the human ultimately responsible. Never an agent identity. |
| `trace` | back-reference to the original instruction — a Gmail message id, a UI session, a TARS action id. Every published commit cites this. |
| `intent` | one of the verbs in §3. |
| `target` | `listing_id`, or `{listing_id, plan_index}` for a multifamily floor plan. |
| `changes` | only fields the intent allows. Unknown keys are rejected, not ignored. |
| `authorization` | how this was authorised. Iris **re-checks**; she does not take `verified: true` on faith. |
| `publish` | `auto` for reversible changes in standalone mode; `propose_only` always in managed mode. |

### Rejection is loud

An envelope missing `operator`, `intent`, `target`, or a passing `authorization` is **refused with a
reason**, never partially applied. Iris reports the refusal to whoever issued it.

---

## 3. Intents

| Intent | `changes` keys | Publish |
|---|---|---|
| `set_status` | `status` ∈ available / coming_soon / leased / inquire | auto |
| `set_price` | `rent` | auto |
| `set_copy` | `note`, `badge_label` | auto |
| `set_specs` | `beds`, `baths`, `sqft` | auto |
| `set_plan` | `status`, `rent`, `count`, `beds`, `baths`, `sqft` (needs `plan_index`) | auto |
| `add_photos` | `photo_refs[]` — Drive ids, local paths, or URLs | auto |
| `set_hero_photo` | `photo` | auto |
| `remove_photos` | `photos[]` or `clear: true` | auto |
| `reorder` | `position` | auto |
| `create_listing` | full listing fields | **confirm** |
| `remove_listing` | — | **confirm** |

Status changes cascade — leasing a home also greys the price, drops the Apply button and tour link,
and swaps the placeholder artwork. Callers state the *outcome*, not the mechanics. `listing-edit.js`
owns the cascade so every source gets identical behaviour.

---

## 4. Mode switching

Set in `iris/iris.json`. **Exactly one command source may be live.**

### `mode: "standalone"` — today

- `command_sources.email.enabled = true`
- `command_sources.chief_of_staff.enabled = false`
- Autonomy: `L1_auto_publish_reversible`
- Iris reads the mailbox, translates to envelopes, executes, publishes, replies

### `mode: "managed"` — when Foundation Layer plugs in

- `command_sources.email.enabled` → **ignored regardless of value.** The mode gate wins.
- `command_sources.chief_of_staff.enabled = true`
- Autonomy drops to **`L1_propose_only`**
- The scheduled email poller must be **disabled**, not merely unread

**Autonomy must drop on handoff.** Foundation Layer has no auto-commit branch anywhere — Quinn
proposes, humans approve, `action_policy.py` is inert by construction. Iris auto-publishing inside
FL would make her the single exception to the platform's core safety property. Don't.

### The handoff, in order

1. Disable the `ech-listing-intake` scheduled task
2. Set `mode: "managed"`, flip both `enabled` flags
3. Set `autonomy.level` to `L1_propose_only`
4. Confirm FL's `website-it` tile reaches Iris's executor and **not** the repo directly
5. Only then point TARS at Iris

Reverse the order to go back to standalone.

---

## 5. One writer. This is not negotiable.

`ech-website`'s listing region — everything between `LISTINGS:START` and `LISTINGS:END` — has
**exactly one writer: Iris.**

`build-listings.js` regenerates that region wholesale from `data/listings.json`. A second writer
doesn't merge, it loses. The pre-flight guard aborts if the working copy differs from `origin/main`
outside the markers — so a competing writer surfaces as a refused publish, not silent corruption.

**Known risk:** Foundation Layer's `BACKEND_HUB_SPEC.md` §3 specs a connector broker with
`ech-website repo (Pages) | Website & IT | publish listings + availability feed`. If that gets built
as a direct repo writer, it collides with Iris. **The broker must call Iris, not the repo.** Nobody
had written that down before this file.

Everything outside the markers — page copy, nav, FAQs, styles — is a human's job, not Iris's.

---

## 6. What Iris will not do

- Guess a price, square footage, or availability date. Absent means UNKNOWN and renders with no
  price line. `$0/mo` on a public rental page is worse than blank.
- Publish a listing whose photos aren't verifiably loading.
- Touch anything outside the listing markers.
- Put occupant names, lease dates, or balances anywhere near `listings.json` — it ships to a
  **public repo**.
- Act on an instruction whose authorisation she can't re-verify herself.
- Reply to an unauthorised sender. Silence, not a bounce — a reply confirms the mailbox is monitored.

---

## 7. Why the mailbox is resolved at runtime

`command_sources.email.mailbox` is `"auto"` deliberately. Iris reads whatever the Gmail connector is
authenticated as and **reports which mailbox she used**.

**Today, standalone, the command inbox is `jerry.eads@echmanagement.services`** — because that is
what the Gmail connector on this machine is authenticated as, and that connector is deliberately not
being changed. Ashley sends *to* jerry.eads@. `docs/ASHLEY_HOW_TO.md` says so, and the two must
never disagree.

`manager@echmanagement.services` is the **business** inbox — website enquiries, tenant mail, vendor
mail. It is the intended command inbox **under Foundation Layer**, which reaches it through its own
per-tenant OAuth row rather than this machine's connector. It is not the command inbox today.

> **Why this is written down so bluntly.** These two got out of step once. If a doc tells Ashley to
> mail manager@ while Iris is reading jerry.eads@, her email is never seen — and she gets no reply,
> because §6 says Iris stays silent to unrecognised senders. A command that vanishes without a
> bounce is the worst failure this system has. Whenever the connector identity changes, change
> ASHLEY_HOW_TO.md in the same commit.

Hardcoding an address would break the standalone product the moment a second customer used it — and
would silently read the wrong inbox if a connector were ever reconnected. Resolve, report, never
assume.

> Foundation Layer reads manager@ through its own per-tenant OAuth row in `google_connections`,
> resolved by `fetch_by_tenant(scope.tenant_id)`. That is a **separate connection** from the one
> Iris uses standalone. Two independent paths to the same mailbox — don't conflate them.

---

## 8. Where this sits in Foundation Layer

| FL concept | Iris's place |
|---|---|
| `website-it` tile | Iris's surface. Currently **GAP on all six columns** — "no API surface," unmoved across ~18 proving runs |
| Employee charter | Iris — Marketing & IT. Chips: *"Publish a new listing"*, *"Syndicate to Zillow + Facebook"* |
| Connector broker (§3) | must route **through** Iris, never straight to the repo |
| `ai_employees` table | Iris needs a row + `hired=true` before she can act under FL |
| `properties.details` | the natural upstream — vacant unit → listing draft |
| `action_policy.py` | add `listing_update` when L2 autonomy is ever wanted. Inert today. |

**What Website Control already solves that FL hasn't:** the publish-to-Pages last mile. FL has the
`propose → approve` skeleton everywhere and can reuse it verbatim, but nothing in FL can commit to a
Pages repo. That mechanism is the expensive part, and it's built and tested.

---

## 9. Files

| Path | Role |
|---|---|
| `iris/iris.json` | mode + command sources + capabilities |
| `iris/IRIS_CONTRACT.md` | this document |
| `tools/iris-execute.js` | **the single entry point.** Consumes an envelope, executes, reports. Every source goes through here. |
| `tools/listing-edit.js` | the deterministic listing mutations + cascades |
| `tools/build-listings.js` | regenerates the static pages; validates and refuses bad data |
| `tools/photo_pipeline.py` | resize, strip EXIF/GPS, upload to the public bucket |
| `data/listings.json` | source of truth |
| `docs/FL_LISTINGS_CONTRACT.md` | the data seam FL takes over later |

## Last reviewed

**2026-08-03** — written when the standalone-vs-FL architecture was settled: Iris is an employee,
TARS is the Chief of Staff, and the command source is swappable.
