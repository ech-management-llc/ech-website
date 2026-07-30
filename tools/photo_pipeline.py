#!/usr/bin/env python3
"""photo_pipeline.py — take raw phone photos and put them on the public CDN.

A phone photo is 3-12 MB and 4000px wide. Putting that straight on a listing card would
make the page unusable on mobile, which is where renters actually look. This resizes,
strips EXIF (phone photos carry GPS coordinates of the property — do not publish those),
uploads to the Supabase public `listing-photos` bucket, and prints the public URLs.

    python3 tools/photo_pipeline.py <listing-id> <file-or-dir> [more...]
    python3 tools/photo_pipeline.py --list <listing-id>
    python3 tools/photo_pipeline.py --delete <listing-id> <NN.jpg>

Output: one public https URL per line on stdout (feed straight into listing-edit.js --add-url).
Diagnostics go to stderr so stdout stays pipeable.

Credentials come from the Foundation Layer .env (SUPABASE_URL + SUPABASE_SECRET_KEY) or from
the environment. Nothing is ever written into this repo.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError:
    sys.exit("✗ Pillow required:  pip install Pillow --break-system-packages")

try:
    import httpx
except ImportError:
    httpx = None
    import urllib.request

BUCKET = "listing-photos"
MAX_EDGE = 1600          # plenty for a card hero and a full-width mobile view
JPEG_QUALITY = 82        # visually clean, ~150-350 KB at 1600px
SRC_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".tif", ".tiff"}

FL_ENV_CANDIDATES = [
    Path("/sessions/youthful-keen-johnson/mnt/06_PROJECTS/foundation-layer/.env"),
    Path.home() / "Desktop/MEGA_BRAIN/MEGA_BRAIN/06_PROJECTS/foundation-layer/.env",
    Path(__file__).resolve().parents[2] / "foundation-layer" / ".env",
]


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def creds() -> tuple[str, str]:
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SECRET_KEY")
    if url and key:
        return url.rstrip("/"), key

    for env_path in FL_ENV_CANDIDATES:
        if not env_path.exists():
            continue
        found: dict[str, str] = {}
        for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            found[k.strip()] = v.strip().strip("\"'")
        url, key = found.get("SUPABASE_URL"), found.get("SUPABASE_SECRET_KEY")
        if url and key:
            log(f"  credentials: {env_path}")
            return url.rstrip("/"), key

    sys.exit(
        "✗ no Supabase credentials.\n"
        "  Set SUPABASE_URL and SUPABASE_SECRET_KEY, or ensure foundation-layer/.env is readable."
    )


def http(method: str, url: str, key: str, body: bytes | None = None,
         content_type: str | None = None) -> tuple[int, bytes]:
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    if content_type:
        headers["Content-Type"] = content_type
        headers["x-upsert"] = "true"
    if httpx is not None:
        r = httpx.request(method, url, headers=headers, content=body, timeout=90.0)
        return r.status_code, r.content
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            return resp.status, resp.read()
    except Exception as e:  # noqa: BLE001 - surface any transport failure to the caller
        code = getattr(e, "code", 0)
        return code, str(e).encode()


def normalise(src: Path) -> bytes:
    """Resize, correct orientation, strip metadata, re-encode as progressive JPEG."""
    with Image.open(src) as im:
        # Phones record orientation in EXIF rather than rotating pixels; bake it in before
        # stripping metadata, or half the photos publish sideways.
        im = ImageOps.exif_transpose(im)
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        before = im.size
        im.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)

        # Rebuilding from raw pixel bytes guarantees no EXIF/GPS rides along into the public file.
        clean = Image.frombytes(im.mode, im.size, im.tobytes())

        import io

        buf = io.BytesIO()
        clean.save(buf, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
        log(f"    {src.name}: {before[0]}x{before[1]} → {im.size[0]}x{im.size[1]},"
            f" {src.stat().st_size / 1024:.0f} KB → {len(buf.getvalue()) / 1024:.0f} KB, EXIF stripped")
        return buf.getvalue()


def existing(listing: str, url: str, key: str) -> list[str]:
    code, body = http("POST", f"{url}/storage/v1/object/list/{BUCKET}", key,
                      body=f'{{"prefix":"{listing}/","limit":200}}'.encode(),
                      content_type="application/json")
    if code >= 300:
        return []
    import json

    try:
        return sorted(o["name"] for o in json.loads(body))
    except Exception:  # noqa: BLE001
        return []


def public_url(url: str, listing: str, name: str) -> str:
    return f"{url}/storage/v1/object/public/{BUCKET}/{listing}/{name}"


def gather(paths: list[str]) -> list[Path]:
    out: list[Path] = []
    for raw in paths:
        p = Path(raw)
        if p.is_dir():
            out.extend(sorted(f for f in p.iterdir() if f.suffix.lower() in SRC_EXT))
        elif p.is_file():
            if p.suffix.lower() not in SRC_EXT:
                sys.exit(f"✗ unsupported image type: {p.name}")
            out.append(p)
        else:
            sys.exit(f"✗ not found: {raw}")
    if not out:
        sys.exit("✗ no images found in the given paths")
    return out


def main() -> None:
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        sys.exit(__doc__)

    url, key = creds()

    if args[0] == "--list":
        listing = args[1]
        names = existing(listing, url, key)
        log(f"  {len(names)} photo(s) for {listing}")
        for n in names:
            print(public_url(url, listing, n))
        return

    if args[0] == "--delete":
        listing, name = args[1], args[2]
        code, body = http("DELETE", f"{url}/storage/v1/object/{BUCKET}/{listing}/{name}", key)
        if code >= 300:
            sys.exit(f"✗ delete failed ({code}): {body[:200]!r}")
        log(f"✓ deleted {listing}/{name}")
        return

    listing, srcs = args[0], gather(args[1:])
    if not listing.replace("-", "").isalnum():
        sys.exit(f"✗ listing id must be lowercase alphanumeric + hyphens, got '{listing}'")

    taken = set(existing(listing, url, key))
    n = 1
    urls: list[str] = []

    log(f"  uploading {len(srcs)} photo(s) to {BUCKET}/{listing}/")
    for src in srcs:
        while f"{n:02d}.jpg" in taken:
            n += 1
        name = f"{n:02d}.jpg"
        taken.add(name)

        data = normalise(src)
        code, body = http("POST", f"{url}/storage/v1/object/{BUCKET}/{listing}/{name}", key,
                          body=data, content_type="image/jpeg")
        if code >= 300:
            sys.exit(f"✗ upload of {src.name} failed ({code}): {body[:300]!r}")

        pub = public_url(url, listing, name)
        log(f"    → {name}")
        urls.append(pub)

    # Confirm at least the first upload is actually publicly readable — a private bucket or a
    # bad policy would otherwise ship broken images to the live site.
    check, _ = http("GET", urls[0], "")
    if check != 200:
        log(f"  ⚠ WARNING: {urls[0]} returned HTTP {check} without auth."
            f" The bucket may not be public — do not publish until this reads 200.")
    else:
        log(f"  ✓ public read verified (HTTP 200)")

    for u in urls:
        print(u)


if __name__ == "__main__":
    main()
