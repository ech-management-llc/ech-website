#!/usr/bin/env node
/**
 * listing-edit.js — deterministic CLI for mutating data/listings.json.
 *
 * The intake agent parses Jerry's plain-English email and then calls THIS, rather than
 * rewriting JSON itself. That keeps every listing change validated, reversible and
 * identical whether a human or an agent made it.
 *
 *   node tools/listing-edit.js list [--available]
 *   node tools/listing-edit.js show <id>
 *   node tools/listing-edit.js set <id> [--status s] [--rent n] [--note "..."] [--beds n]
 *                                       [--baths n] [--sqft n] [--city "..."] [--address "..."]
 *                                       [--tour url|none] [--cta apply|waitlist|none] [--scene k]
 *   node tools/listing-edit.js plan <id> <index> [--status s] [--rent n] [--count n]   # multifamily
 *   node tools/listing-edit.js photos <id> --add <path...> [--first <file>]
 *   node tools/listing-edit.js photos <id> --remove <file...> | --clear
 *   node tools/listing-edit.js add <id> --page p --address "..." --city "..." [...]
 *   node tools/listing-edit.js remove <id>
 *   node tools/listing-edit.js reorder <id> <position>
 *
 * Every mutating command rewrites listings.json, stamps last_updated/updated_by, and prints
 * a one-line summary of what changed. Run tools/build-listings.js afterwards to render.
 * Nothing here touches git — publishing is a separate, explicit step.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'data', 'listings.json');
const SCENES = path.join(ROOT, 'data', 'scenes.json');

const STATUSES = ['available', 'coming_soon', 'leased', 'inquire'];
const PAGES = ['single-family', 'apartment'];
const PHOTO_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.avif'];

/** Status defaults. Applied on --status unless the flag is also given explicitly. */
const STATUS_DEFAULTS = {
  single_family: {
    available: { note: 'Available now — apply today', cta: 'apply', badge_label: 'Available' },
    coming_soon: {
      note: 'Available ~1 month — no application fee to join the waitlist',
      cta: 'waitlist',
      badge_label: 'Coming Soon',
    },
    leased: { note: 'Currently leased', cta: 'none', badge_label: 'Rented' },
    inquire: { note: 'Contact us for availability', cta: 'waitlist', badge_label: 'Inquire' },
  },
  multifamily: {
    available: { cta: 'apply', badge_label: 'Available' },
    coming_soon: { cta: 'waitlist', badge_label: 'Coming Soon' },
    leased: {
      note: 'Fully leased — join the waitlist (no application fee)',
      cta: 'waitlist',
      badge_label: 'Leased',
    },
    inquire: { cta: 'waitlist', badge_label: 'Inquire' },
  },
};

/** Scene pools per kind+status, so a leased home never shows a "NOW LEASING" sign. */
const SCENE_POOLS = {
  single_family: {
    available: ['available-home-with-a-now-leasing-sign-and-balloon'],
    coming_soon: ['home-under-construction-with-a-builder-on-a-ladder'],
    inquire: ['available-home-with-a-now-leasing-sign-and-balloon'],
    leased: [
      'leased-home-with-a-person-mowing-the-lawn',
      'leased-home-with-a-person-waving',
      'leased-home-with-a-backyard-barbecue-and-a-dog',
      'leased-home-with-two-people-tossing-a-football',
      'leased-home-with-a-small-family-out-front',
      'leased-home-with-a-person-heading-inside',
      'leased-home-with-a-child-and-a-dog-playing',
      'leased-home-with-a-person-watering-the-garden',
    ],
  },
  multifamily: {
    available: [
      'multifamily-building-with-a-resident-waving',
      'multifamily-building-with-a-resident-heading-inside',
      'multifamily-building-with-a-resident-walking-a-dog',
    ],
    coming_soon: ['multifamily-building-with-a-resident-waving'],
    inquire: ['multifamily-building-with-a-resident-waving'],
    leased: ['leased-multifamily-building-with-a-courtyard-barbecue-and-a-dog'],
  },
};

// ---------------------------------------------------------------- plumbing

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function load() {
  if (!fs.existsSync(FILE)) die(`data/listings.json not found at ${FILE}`);
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}

/**
 * Write listings.json — but only if the listings actually changed.
 *
 * Found by running the email path end to end: "500 Reynolds leased" on a listing that was already
 * leased still rewrote last_updated/updated_by, so the file came back dirty with no real change.
 * Publish would then have made a commit whose entire diff was a timestamp.
 *
 * That matters more than it looks. Re-sending the same instruction is the most natural thing a
 * person does when they aren't sure the first one landed — Ashley will do it, and so will you. Every
 * one of those would have become an empty commit, and an audit trail full of nothing is one nobody
 * reads. So: compare the listings themselves, ignoring the stamp, and no-op means no write.
 */
function save(data, who) {
  const before = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : '';
  let prevListings = null;
  try { prevListings = JSON.stringify(JSON.parse(before).listings); } catch {}

  if (prevListings !== null && prevListings === JSON.stringify(data.listings)) {
    return { written: false };            // nothing substantive changed; leave the file alone
  }

  data.last_updated = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  data.updated_by = who || 'listing-edit.js';
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return { written: true };
}

function find(data, id) {
  const l = data.listings.find((x) => x.id === id);
  if (!l) {
    const near = data.listings
      .map((x) => x.id)
      .filter((x) => x.includes(id.split('-')[0]) || id.includes(x.split('-')[0]));
    die(
      `no listing with id "${id}"` +
        (near.length ? `\n  did you mean: ${near.join(', ')}` : `\n  run: listing-edit.js list`)
    );
  }
  return l;
}

/** Parse `--flag value` / `--flag` argv into an object; positionals collected separately. */
function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const vals = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) vals.push(argv[++i]);
      flags[key] = vals.length === 0 ? true : vals.length === 1 ? vals[0] : vals;
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function numOrDie(v, name) {
  const n = Number(String(v).replace(/[$,]/g, ''));
  if (!Number.isFinite(n)) die(`--${name} must be a number, got "${v}"`);
  return n;
}

/** Stable pick from a pool so the same listing keeps the same scene across runs. */
function pickScene(pool, id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return pool[h % pool.length];
}

function applyStatus(l, status, flags) {
  const defaults = (STATUS_DEFAULTS[l.kind] || {})[status] || {};
  const changed = [`status ${l.status} → ${status}`];
  l.status = status;

  for (const [k, v] of Object.entries(defaults)) {
    if (flags[k] === undefined) {
      if (l[k] !== v) changed.push(`${k} → ${v === null ? 'null' : `"${v}"`}`);
      l[k] = v;
    }
  }
  // A leased single-family card shouldn't advertise a tour slot.
  if (status === 'leased' && l.kind === 'single_family' && flags.tour === undefined) {
    if (l.virtual_tour) changed.push('virtual_tour → null');
    l.virtual_tour = null;
  }
  if (l.cta === 'waitlist' && !l.waitlist_label) {
    l.waitlist_label = `${l.address}, ${l.city}`;
    changed.push(`waitlist_label → "${l.waitlist_label}"`);
  }
  // Only swap the placeholder scene when there's no real photo carrying the card.
  if ((l.photos || []).length === 0 && flags.scene === undefined) {
    const pool = (SCENE_POOLS[l.kind] || {})[status];
    if (pool && !pool.includes(l.scene)) {
      l.scene = pickScene(pool, l.id);
      changed.push(`scene → ${l.scene}`);
    }
  }
  return changed;
}

const FIELD_SETTERS = {
  rent: (l, v) => (l.rent = numOrDie(v, 'rent')),
  beds: (l, v) => (l.beds = numOrDie(v, 'beds')),
  baths: (l, v) => (l.baths = numOrDie(v, 'baths')),
  sqft: (l, v) => (l.sqft = numOrDie(v, 'sqft')),
  note: (l, v) => (l.note = v === 'none' ? null : v),
  address: (l, v) => (l.address = v),
  city: (l, v) => (l.city = v),
  state: (l, v) => (l.state = v),
  badge_label: (l, v) => (l.badge_label = v),
  scene: (l, v) => (l.scene = v),
  tour: (l, v) => (l.virtual_tour = v === 'none' ? null : v),
  cta: (l, v) => {
    if (!['apply', 'waitlist', 'none'].includes(v)) die(`--cta must be apply|waitlist|none`);
    l.cta = v;
  },
  units_available: (l, v) => (l.units_available = numOrDie(v, 'units_available')),
};

// ---------------------------------------------------------------- commands

function cmdList(data, flags) {
  let rows = data.listings.slice().sort((a, b) => a.page.localeCompare(b.page) || a.order - b.order);
  if (flags.available) rows = rows.filter((l) => l.status !== 'leased');
  console.log(`${rows.length} listing(s)  —  data/listings.json (source: ${data.source})\n`);
  for (const l of rows) {
    const rent =
      l.kind === 'multifamily'
        ? `${l.units_available ?? 0} avail / ${l.floor_plans.length} plan(s)`
        : l.rent != null
        ? `$${Number(l.rent).toLocaleString('en-US')}`
        : '—';
    const ph = (l.photos || []).length;
    console.log(
      `  ${l.id.padEnd(36)} ${l.status.padEnd(12)} ${String(rent).padEnd(20)} ` +
        `${ph ? `${ph} photo${ph > 1 ? 's' : ''}` : 'scene only'}`
    );
  }
}

function cmdShow(data, id) {
  console.log(JSON.stringify(find(data, id), null, 2));
}

function cmdSet(data, id, flags) {
  const l = find(data, id);
  const changes = [];

  if (flags.status) {
    if (!STATUSES.includes(flags.status)) die(`--status must be one of: ${STATUSES.join(', ')}`);
    changes.push(...applyStatus(l, flags.status, flags));
  }
  for (const [k, set] of Object.entries(FIELD_SETTERS)) {
    if (flags[k] !== undefined && k !== 'status') {
      const before = k === 'tour' ? l.virtual_tour : l[k];
      set(l, flags[k]);
      const after = k === 'tour' ? l.virtual_tour : l[k];
      if (String(before) !== String(after)) changes.push(`${k}: ${before} → ${after}`);
    }
  }
  if (!changes.length) die('nothing to change — no recognised flags given');
  save(data, `listing-edit set ${id}`);
  console.log(`✓ ${id}\n  ` + changes.join('\n  '));
}

function cmdPlan(data, id, idxRaw, flags) {
  const l = find(data, id);
  if (l.kind !== 'multifamily') die(`${id} is not a multifamily listing (no floor plans)`);
  const idx = Number(idxRaw);
  if (!Number.isInteger(idx) || idx < 1 || idx > l.floor_plans.length) {
    die(`plan index must be 1..${l.floor_plans.length}\n  ${JSON.stringify(l.floor_plans)}`);
  }
  const p = l.floor_plans[idx - 1];
  const changes = [];

  if (flags.status) {
    if (!['available', 'leased'].includes(flags.status)) die('plan --status must be available|leased');
    changes.push(`status ${p.status} → ${flags.status}`);
    p.status = flags.status;
    if (flags.count === undefined) p.available_count = flags.status === 'leased' ? 0 : 1;
  }
  if (flags.rent !== undefined) {
    changes.push(`rent ${p.rent} → ${flags.rent}`);
    p.rent = numOrDie(flags.rent, 'rent');
  }
  if (flags.count !== undefined) {
    p.available_count = numOrDie(flags.count, 'count');
    p.status = p.available_count > 0 ? 'available' : 'leased';
    changes.push(`available_count → ${p.available_count} (status ${p.status})`);
  }
  for (const k of ['beds', 'baths', 'sqft']) {
    if (flags[k] !== undefined) {
      changes.push(`${k} ${p[k]} → ${flags[k]}`);
      p[k] = numOrDie(flags[k], k);
    }
  }
  if (!changes.length) die('nothing to change');

  // Building-level rollup follows the plans, so the badge can never contradict the unit list.
  const avail = l.floor_plans.reduce(
    (n, q) => n + (q.status === 'available' ? q.available_count || 1 : 0),
    0
  );
  l.units_available = avail;
  const nowStatus = avail > 0 ? 'available' : 'leased';
  if (l.status !== nowStatus) {
    changes.push(...applyStatus(l, nowStatus, {}));
  } else if (nowStatus === 'available') {
    l.note = `${avail} unit${avail > 1 ? 's' : ''} available now — apply today`;
    changes.push(`note → "${l.note}"`);
  }

  save(data, `listing-edit plan ${id} #${idx}`);
  console.log(`✓ ${id} plan #${idx}\n  ` + changes.join('\n  '));
}

function cmdPhotos(data, id, flags) {
  const l = find(data, id);
  const destDir = path.join(ROOT, 'assets', 'properties', l.id);
  const webDir = `/assets/properties/${l.id}`;
  l.photos = l.photos || [];
  const changes = [];

  if (flags.clear) {
    changes.push(`removed all ${l.photos.length} photo(s) — card falls back to scene "${l.scene}"`);
    l.photos = [];
  }

  // Remote photos (Supabase public bucket) — the phone path. tools/photo_pipeline.py has
  // already resized, stripped EXIF and uploaded; we just record the URLs it printed.
  for (const u of asArray(flags['add-url'])) {
    if (!/^https:\/\/\S+$/.test(u)) die(`--add-url expects an https URL, got "${u}"`);
    if (l.photos.includes(u)) {
      changes.push(`= ${u} (already present, skipped)`);
      continue;
    }
    l.photos.push(u);
    changes.push(`+ ${u}`);
  }

  for (const src of asArray(flags.add)) {
    if (!fs.existsSync(src)) die(`photo not found: ${src}`);
    const ext = path.extname(src).toLowerCase();
    if (!PHOTO_EXT.includes(ext)) die(`unsupported photo type "${ext}" (${PHOTO_EXT.join(', ')})`);

    fs.mkdirSync(destDir, { recursive: true });
    // Sequential names keep ordering obvious and avoid phone filename collisions (IMG_0001.jpg).
    let n = 1;
    while (fs.existsSync(path.join(destDir, `${String(n).padStart(2, '0')}${ext}`))) n++;
    const name = `${String(n).padStart(2, '0')}${ext}`;
    fs.copyFileSync(src, path.join(destDir, name));
    const web = `${webDir}/${name}`;
    if (!l.photos.includes(web)) l.photos.push(web);
    changes.push(`+ ${web}  (${(fs.statSync(src).size / 1024).toFixed(0)} KB from ${path.basename(src)})`);
  }

  for (const rm of asArray(flags.remove)) {
    const web = rm.startsWith('/') ? rm : `${webDir}/${rm}`;
    const before = l.photos.length;
    l.photos = l.photos.filter((p) => p !== web);
    if (l.photos.length === before) die(`${id} has no photo "${web}"`);
    const disk = path.join(ROOT, web.replace(/^\//, ''));
    if (fs.existsSync(disk)) fs.unlinkSync(disk);
    changes.push(`- ${web}`);
  }

  if (flags.first) {
    const web = flags.first.startsWith('/') ? flags.first : `${webDir}/${flags.first}`;
    if (!l.photos.includes(web)) die(`${id} has no photo "${web}" to promote`);
    l.photos = [web, ...l.photos.filter((p) => p !== web)];
    changes.push(`hero → ${web}`);
  }

  if (!changes.length) die('nothing to do — use --add-url, --add, --remove, --clear or --first');
  save(data, `listing-edit photos ${id}`);
  console.log(`✓ ${id} — ${l.photos.length} photo(s)\n  ` + changes.join('\n  '));
}

function cmdAdd(data, id, flags) {
  if (data.listings.some((l) => l.id === id)) die(`listing "${id}" already exists — use set`);
  if (!/^[a-z0-9-]+$/.test(id)) die('id must be lowercase letters, numbers and hyphens only');

  for (const req of ['page', 'address', 'city']) {
    if (!flags[req]) die(`add requires --${req}`);
  }
  if (!PAGES.includes(flags.page)) die(`--page must be one of: ${PAGES.join(', ')}`);

  const kind = flags.page === 'apartment' ? 'multifamily' : 'single_family';
  const status = flags.status || 'available';
  if (!STATUSES.includes(status)) die(`--status must be one of: ${STATUSES.join(', ')}`);

  const sameePage = data.listings.filter((l) => l.page === flags.page);
  const l = {
    id,
    fl_property_id: null,
    page: flags.page,
    kind,
    order: flags.order ? numOrDie(flags.order, 'order') : sameePage.length + 1,
    address: flags.address,
    city: flags.city,
    state: flags.state || 'TX',
    status,
    badge_label: null,
    photos: [],
    scene: null,
  };

  if (kind === 'multifamily') {
    l.units_available = 0;
    l.all_bills_paid = flags.all_bills_paid !== 'false';
    l.bills_text = 'Electricity, water, sewer, trash & internet included.';
    l.floor_plans = [];
    if (flags.beds || flags.rent) {
      l.floor_plans.push({
        beds: flags.beds ? numOrDie(flags.beds, 'beds') : null,
        baths: flags.baths ? numOrDie(flags.baths, 'baths') : null,
        sqft: flags.sqft ? numOrDie(flags.sqft, 'sqft') : null,
        rent: flags.rent ? numOrDie(flags.rent, 'rent') : null,
        status: status === 'leased' ? 'leased' : 'available',
        available_count: status === 'leased' ? 0 : 1,
      });
      l.units_available = status === 'leased' ? 0 : 1;
    }
  } else {
    for (const k of ['beds', 'baths', 'sqft', 'rent']) {
      l[k] = flags[k] !== undefined ? numOrDie(flags[k], k) : null;
    }
    l.virtual_tour = flags.tour && flags.tour !== 'none' ? flags.tour : null;
  }

  l.cta = 'none';
  l.note = null;
  l.waitlist_label = null;
  l.scene = pickScene(SCENE_POOLS[kind][status], id);
  applyStatus(l, status, { scene: l.scene });
  if (flags.note) l.note = flags.note;
  if (flags.cta) FIELD_SETTERS.cta(l, flags.cta);
  if (kind === 'multifamily' && status !== 'leased' && l.units_available > 0) {
    l.note = `${l.units_available} unit${l.units_available > 1 ? 's' : ''} available now — apply today`;
  }

  data.listings.push(l);
  fs.mkdirSync(path.join(ROOT, 'assets', 'properties', id), { recursive: true });
  save(data, `listing-edit add ${id}`);
  console.log(
    `✓ added ${id} to ${flags.page} at position ${l.order}\n` +
      `  ${l.address}, ${l.city} ${l.state} — ${l.status}\n` +
      `  no photos yet: showing scene "${l.scene}". Add with: listing-edit photos ${id} --add <file>`
  );
}

function cmdRemove(data, id) {
  const l = find(data, id);
  data.listings = data.listings.filter((x) => x.id !== id);
  // Close the gap so ordering stays 1..n on that page.
  data.listings
    .filter((x) => x.page === l.page)
    .sort((a, b) => a.order - b.order)
    .forEach((x, i) => (x.order = i + 1));
  save(data, `listing-edit remove ${id}`);
  console.log(
    `✓ removed ${id} (${l.address})\n` +
      `  photos left on disk at assets/properties/${id}/ — delete manually if truly gone`
  );
}

function cmdReorder(data, id, posRaw) {
  const l = find(data, id);
  const pos = Number(posRaw);
  const peers = data.listings.filter((x) => x.page === l.page).sort((a, b) => a.order - b.order);
  if (!Number.isInteger(pos) || pos < 1 || pos > peers.length) {
    die(`position must be 1..${peers.length} for page ${l.page}`);
  }
  const rest = peers.filter((x) => x.id !== id);
  rest.splice(pos - 1, 0, l);
  rest.forEach((x, i) => (x.order = i + 1));
  save(data, `listing-edit reorder ${id}`);
  console.log(`✓ ${id} moved to position ${pos} of ${peers.length} on ${l.page}`);
}

// ---------------------------------------------------------------- entry

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseArgs(rest);
  const data = load();

  switch (cmd) {
    case 'list':
      return cmdList(data, flags);
    case 'show':
      return cmdShow(data, pos[0] || die('show needs an id'));
    case 'set':
      return cmdSet(data, pos[0] || die('set needs an id'), flags);
    case 'plan':
      return cmdPlan(data, pos[0] || die('plan needs an id'), pos[1] || die('plan needs an index'), flags);
    case 'photos':
      return cmdPhotos(data, pos[0] || die('photos needs an id'), flags);
    case 'add':
      return cmdAdd(data, pos[0] || die('add needs an id'), flags);
    case 'remove':
      return cmdRemove(data, pos[0] || die('remove needs an id'));
    case 'reorder':
      return cmdReorder(data, pos[0] || die('reorder needs an id'), pos[1]);
    case 'scenes':
      return console.log(Object.keys(JSON.parse(fs.readFileSync(SCENES, 'utf8'))).join('\n'));
    default:
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1].trim());
      process.exit(cmd ? 1 : 0);
  }
}

main();
