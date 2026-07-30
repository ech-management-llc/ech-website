# Updating listings from your phone

Two things to remember: **email for words, Drive folder for photos.**

An agent checks both every hour between 7am and 8pm and publishes what it finds.

---

## Changing a price or status

Email yourself. Subject line starts with `LISTING:`. Body optional.

```
LISTING: 124 Pierce leased
LISTING: 102 Remington available, 1950
LISTING: 500 Reynolds note Available Sept 1
LISTING: 13074 unit 1 leased
LISTING: LC Way 3 units open
```

Plain English is fine — you don't have to match a format. Just make sure the address is
identifiable. Within the hour you get a reply telling you what went live.

Leasing a home automatically drops its price to grey, changes the badge to Rented, removes the
Apply button and the tour link, and swaps the placeholder art to a lived-in scene. You don't have
to say any of that.

## Adding photos

1. Take the photos.
2. Share → Google Drive → folder **ECH_LISTING_PHOTOS**.
3. Email yourself: `LISTING: 124 Pierce +photos`

The first photo becomes the card's main image; the rest become thumbnails. If you want a specific
one to lead, say so: `LISTING: 124 Pierce +photos, use the kitchen one first`.

Photos get resized automatically, so don't worry about file size. **GPS location data is stripped
before anything is published** — phone photos tag where they were taken, and that shouldn't be on
a public rental page.

## Adding or removing a whole listing

Same idea, but this one waits for your OK before going live:

```
LISTING: new 900 New St, Athens, 3 bed 2 bath 1200 sqft, 1650
```

You'll get a reply showing exactly what it's about to publish. Reply yes and it goes.

## If something's wrong

Reply `revert` to the confirmation email. Each update is its own commit, so undoing one doesn't
touch anything else.

If the agent can't tell which property you mean, it asks instead of guessing. Nothing gets
published on a guess.

---

## What it will never do

- Guess a price, a square footage, or an availability date
- Publish a listing whose photos aren't actually loading
- Carry unrelated website changes live alongside a listing update
- Put anything tenant-related on the public site

## From a desk instead

See `tools/README.md`. The CLI does everything the email path does, with more control.
