# Updating listings from your phone

Two things to remember: **email for words, Drive folder for photos.**

An agent checks both every hour between 7am and 8pm and publishes what it finds.

## The two accounts

|  | Account |
|---|---|
| **Email** — your commands | `jerry.eads@echmanagement.services` → send to **yourself** |
| **Drive** — photo drops | `echmanagementserv@gmail.com`, folder `ECH_LISTING_PHOTOS` |

They're different Google accounts. In the Drive app on your phone, make sure the account
selector shows **echmanagementserv@gmail.com** or you won't see the folder.

## Every subject line ends with `#PROCEED`

Without that tag, nothing happens. The from-address alone is not a lock — SPF and DMARC are now
published on the domain, but DMARC is still in observe-only mode (`p=none`) and Google DKIM isn't
signing yet, so a forged email that *looks* like it came from you would still be delivered. The tag
is the real lock. Keep it even after DKIM is in place.

If you forget it, you get a one-line reply reminding you. Nothing publishes.

---

## Changing a price or status

Email yourself. Subject line starts with `LISTING:`. Body optional.

```
LISTING: 124 Pierce leased #PROCEED
LISTING: 102 Remington available, 1950 #PROCEED
LISTING: 500 Reynolds note Available Sept 1 #PROCEED
LISTING: 13074 unit 1 leased #PROCEED
LISTING: LC Way 3 units open #PROCEED
```

Plain English is fine — you don't have to match a format. Just make sure the address is
identifiable. Within the hour you get a reply telling you what went live.

Leasing a home automatically drops its price to grey, changes the badge to Rented, removes the
Apply button and the tour link, and swaps the placeholder art to a lived-in scene. You don't have
to say any of that.

## Adding photos

1. Take the photos.
2. Share → Google Drive → folder **ECH_LISTING_PHOTOS**.
3. Email yourself: `LISTING: 124 Pierce +photos #PROCEED`

**You don't have to pick a main photo.** The card cycles through all of them on its own, about four
seconds each. Drop two or drop eight; it just works. If you do want one to lead, say so:
`LISTING: 124 Pierce +photos, use the kitchen one first #PROCEED`.

Photos get resized automatically, so don't worry about file size. **GPS location data is stripped
before anything is published** — phone photos tag where they were taken, and that shouldn't be on
a public rental page.

## Adding or removing a whole listing

Same idea, but this one waits for your OK before going live:

```
LISTING: new 900 New St, Athens, 3 bed 2 bath 1200 sqft, 1650 #PROCEED
```

You'll get a reply showing exactly what it's about to publish. Reply yes and it goes.

## If something's wrong

Reply `revert` to the confirmation email. Each update is its own commit, so undoing one doesn't
touch anything else.

If the agent can't tell which property you mean, it asks instead of guessing. Nothing gets
published on a guess.

---

## The photo folder is an inbox YOU fill

Nothing appears in it on its own. You put photos in; the agent takes them out. An empty folder is
normal — it only has contents in the gap between your drop and the next hourly run.

```
YOU (phone)                            AGENT (hourly)
1. Take photos
2. Share → Drive → ECH_LISTING_PHOTOS  → 4. Reads your tagged email
3. Email yourself "LISTING: ... #PROCEED"   5. Pulls the photos
                                          6. Resizes, strips GPS, uploads to CDN
                                          7. Rebuilds + publishes
                                       ←  8. Replies with what changed
```

Photos are optional. "124 Pierce leased" needs no photo at all.

## What it will never do

- Guess a price, a square footage, or an availability date
- Publish a listing whose photos aren't actually loading
- Carry unrelated website changes live alongside a listing update
- Put anything tenant-related on the public site

## From a desk instead

See `tools/README.md`. The CLI does everything the email path does, with more control.
