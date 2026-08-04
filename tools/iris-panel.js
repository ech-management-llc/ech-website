#!/usr/bin/env node
/**
 * iris-panel.js — Iris's local control panel. The break-glass path when email isn't working.
 *
 *   node tools/iris-panel.js            then open http://127.0.0.1:7317
 *   node tools/iris-panel.js --port 8080
 *
 * WHY LOCAL: publishing needs git credentials. A credential in a browser on the open internet is a
 * credential anyone can steal. This runs on YOUR machine, where the credentials already live, and
 * binds to 127.0.0.1 only — not reachable from your network, let alone the world.
 *
 * It is the `control_panel` command source in iris/iris.json. Every action becomes the same
 * instruction envelope the email path produces and goes through tools/iris-execute.js. No second
 * code path — if the panel could do something the envelope can't express, that's a bug.
 *
 * Zero dependencies. Node built-ins only.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data', 'listings.json');
const CONFIG = path.join(ROOT, 'iris', 'iris.json');
const AUDIT = path.join(ROOT, 'iris', 'audit.jsonl');

const portArg = process.argv.indexOf('--port');
const PORT = portArg !== -1 ? Number(process.argv[portArg + 1]) : 7317;
const HOST = '127.0.0.1'; // never widen this

const OPERATOR = 'control-panel@localhost';
const MAX_UPLOAD = 40 * 1024 * 1024; // 40 MB per request — phone photos are a few MB each

// ---------------------------------------------------------------- helpers

const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/**
 * Run a command. Every invocation is bounded in time and can never wait on a human.
 *
 * This bit the panel once, so it is worth being explicit. `git push` wants credentials. Under a
 * console it prompts; under a server with piped stdio there is nobody to prompt, so it blocked
 * forever. execFileSync has no default timeout, so the single-threaded server froze mid-publish,
 * the window got closed, and Node died holding .git/index.lock — which then blocked every later
 * git command until the lock was cleared by hand.
 *
 * Two independent guards, because either alone is not enough:
 *   GIT_TERMINAL_PROMPT=0  git fails fast instead of asking. Turns a hang into an error message.
 *   timeout                catches everything else — a slow network, a wedged helper, a hook.
 */
function run(cmd, args, input, timeout = 20000) {
  return execFileSync(cmd, args, {
    cwd: ROOT, encoding: 'utf8', input, maxBuffer: 16 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout,
    killSignal: 'SIGKILL',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'echo',
      GCM_INTERACTIVE: 'never',
    },
  });
}

/**
 * Clear an abandoned .git/index.lock.
 *
 * Only ever removes a ZERO-BYTE lock older than 60s. A lock with content, or a fresh one, belongs
 * to a live git process and removing it could corrupt the index — so we leave it and report it.
 */
function clearStaleGitLock() {
  const lock = path.join(ROOT, '.git', 'index.lock');
  try {
    const st = fs.statSync(lock);
    if (st.size === 0 && Date.now() - st.mtimeMs > 60000) {
      fs.unlinkSync(lock);
      return { cleared: true, ageSec: Math.round((Date.now() - st.mtimeMs) / 1000) };
    }
    return { cleared: false, held: true, size: st.size,
             ageSec: Math.round((Date.now() - st.mtimeMs) / 1000) };
  } catch {
    return { cleared: false };            // no lock, nothing to do
  }
}

function body(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Temporarily allow the control_panel source, run the envelope, restore config. */
function executeEnvelope(env) {
  const cfg = readJSON(CONFIG);
  if ((cfg.mode || '').toLowerCase() === 'managed') {
    return { refused: [
      'Iris is in MANAGED mode — the Chief of Staff owns her orders and the control panel is ' +
      'stood down by design. Set mode="standalone" in iris/iris.json to use the panel again.',
    ], applied: [], notes: [] };
  }

  const wasEnabled = cfg.command_sources.control_panel.enabled;
  if (!wasEnabled) {
    cfg.command_sources.control_panel.enabled = true;
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  }
  try {
    return JSON.parse(run('node', [path.join('tools', 'iris-execute.js'), '--envelope', '-'],
                          JSON.stringify(env)));
  } catch (e) {
    const text = (e.stdout || '').toString();
    try { return JSON.parse(text); } catch {
      return { refused: [(e.stderr || e.message).toString().trim()], applied: [], notes: [] };
    }
  } finally {
    if (!wasEnabled) {
      const c = readJSON(CONFIG);
      c.command_sources.control_panel.enabled = false;
      fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2) + '\n');
    }
  }
}

function envelope(intent, target, changes, extra = {}) {
  return {
    envelope_version: '1.0',
    issued_by: 'control_panel',
    issued_at: new Date().toISOString(),
    operator: OPERATOR,
    trace: `panel:${Date.now()}`,
    intent, target, changes,
    authorization: {
      method: 'session', verified: true,
      detail: 'local control panel on 127.0.0.1 — machine access is the authorisation',
    },
    ...extra,
  };
}

const TRACKED = ['data/listings.json',
                 'single-family-home-rental-cedar-creek-lake.html',
                 'apartment-rental-cedar-creek-lake.html'];

function gitState() {
  try {
    const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const dirty = run('git', ['status', '--porcelain', ...TRACKED]).trim();
    let ahead = 0;
    try { ahead = Number(run('git', ['rev-list', '--count', 'origin/main..HEAD']).trim()) || 0; } catch {}
    return { branch, dirtyFiles: dirty.split('\n').filter(Boolean).length, ahead };
  } catch (e) { return { error: e.message }; }
}

/**
 * What would actually go live. Reads the diff of listings.json against HEAD and turns it into
 * plain-English lines, because "review before you publish" only helps if the review is legible.
 */
function pendingReview() {
  let head;
  try { head = JSON.parse(run('git', ['show', 'HEAD:data/listings.json'])); }
  catch { return { lines: ['(cannot read the published version to compare against)'], count: 0 }; }

  const now = readJSON(DATA);
  const byId = (d) => Object.fromEntries((d.listings || []).map((l) => [l.id, l]));
  const a = byId(head), b = byId(now);
  const lines = [];

  const money = (v) => (v == null ? 'no price' : '$' + Number(v).toLocaleString('en-US'));

  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const o = a[id], n = b[id];
    if (o && !n) { lines.push(`REMOVED   ${o.address}`); continue; }
    if (!o && n) { lines.push(`ADDED     ${n.address} — ${n.status}, ${money(n.rent)}`); continue; }
    const d = [];
    if (o.status !== n.status) d.push(`status ${o.status} → ${n.status}`);
    if (o.rent !== n.rent) d.push(`rent ${money(o.rent)} → ${money(n.rent)}`);
    if ((o.note || '') !== (n.note || '')) d.push(`note → "${n.note || ''}"`);
    for (const k of ['beds', 'baths', 'sqft']) if (o[k] !== n[k]) d.push(`${k} ${o[k]} → ${n[k]}`);
    const op = (o.photos || []).length, np = (n.photos || []).length;
    if (op !== np) d.push(`photos ${op} → ${np}`);
    if (o.order !== n.order) d.push(`position ${o.order} → ${n.order}`);
    if (JSON.stringify(o.floor_plans || []) !== JSON.stringify(n.floor_plans || [])) d.push('floor plans changed');
    if (d.length) lines.push(`${n.address}: ${d.join(' · ')}`);
  }
  return { lines, count: lines.length };
}

function publish(message) {
  try { run('node', ['tools/build-listings.js', '--check']); }
  catch (e) {
    return { ok: false, error: 'pages do not match listings.json — rebuild first',
             detail: (e.stdout || e.stderr || '').toString().trim() };
  }
  const lock = clearStaleGitLock();
  if (lock.held) {
    return { ok: false, error: 'another git process is busy in this repo',
             detail: `.git/index.lock is ${lock.size} bytes, ${lock.ageSec}s old. If GitHub ` +
                     `Desktop is mid-operation, let it finish and try again.` };
  }
  try {
    run('git', ['add', ...TRACKED]);
    const msg = message && message.trim() ? message.trim() : 'listings: update via Iris control panel';
    const commit = run('git', ['commit', '-m', msg]).trim();

    // Commit is safe on this machine; push is the part that needs credentials. Report them
    // separately so a push failure never looks like a lost change — the commit is already made
    // and one click of Push in GitHub Desktop finishes the job.
    let push, pushed = true, pushError = null;
    try {
      push = run('git', ['push', 'origin', 'HEAD'], undefined, 30000).trim();
    } catch (e) {
      pushed = false;
      const d = (e.stderr || e.stdout || e.message || '').toString();
      pushError = /could not read Username|Authentication failed|terminal prompts disabled/i.test(d)
        ? 'Committed locally, but GitHub would not accept the push without credentials. ' +
          'Open GitHub Desktop and click Push origin — your change is safe in the commit.'
        : `Committed locally, but the push failed: ${d.trim().split('\n').slice(-2).join(' ')}`;
      push = '';
    }
    let sha = '';
    try { sha = run('git', ['rev-parse', '--short', 'HEAD']).trim(); } catch {}
    if (!pushed) {
      try {
        fs.appendFileSync(AUDIT, JSON.stringify({
          at: new Date().toISOString(), result: 'committed_not_pushed', source: 'control_panel',
          operator: OPERATOR, commit: sha, message: msg,
        }) + '\n');
      } catch {}
      return { ok: false, committed: true, sha, error: 'published locally, not pushed',
               detail: pushError };
    }
    try {
      fs.appendFileSync(AUDIT, JSON.stringify({
        at: new Date().toISOString(), result: 'published', source: 'control_panel',
        operator: OPERATOR, commit: sha, message: msg,
      }) + '\n');
    } catch {}
    return { ok: true, sha, steps: [commit, push] };
  } catch (e) {
    return { ok: false, error: 'publish failed',
             detail: (e.stdout || e.stderr || e.message).toString().trim() };
  }
}

/** Very small multipart parser — enough for <input type=file multiple>. No dependencies. */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return [];
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const files = [];
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (buf.slice(start, start + 2).toString() === '--') break;
    const headEnd = buf.indexOf('\r\n\r\n', start);
    if (headEnd === -1) break;
    const head = buf.slice(start, headEnd).toString();
    const next = buf.indexOf(boundary, headEnd);
    if (next === -1) break;
    const content = buf.slice(headEnd + 4, next - 2); // strip trailing CRLF
    const fn = /filename="([^"]*)"/i.exec(head);
    if (fn && fn[1] && content.length) files.push({ filename: path.basename(fn[1]), data: content });
    pos = next;
  }
  return files;
}

/** Save uploads to temp, run the photo pipeline, return public URLs. */
function uploadPhotos(listingId, files) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-'));
  const paths = [];
  try {
    for (const f of files) {
      const p = path.join(tmp, f.filename.replace(/[^\w.\-]/g, '_'));
      fs.writeFileSync(p, f.data);
      paths.push(p);
    }
    const stdout = run('python3', ['tools/photo_pipeline.py', listingId, ...paths]);
    const urls = stdout.split('\n').map((s) => s.trim()).filter((s) => /^https:\/\//.test(s));
    if (!urls.length) return { ok: false, error: 'pipeline produced no URLs', detail: stdout.slice(-600) };
    return { ok: true, urls };
  } catch (e) {
    const detail = (e.stderr || e.stdout || e.message).toString();
    // python3 may be `python` on Windows — say so rather than leaving a cryptic ENOENT.
    if (/ENOENT/.test(detail)) {
      return { ok: false, error: 'python3 not found on PATH',
               detail: 'Photo upload needs Python with Pillow. Install Python, or use the email ' +
                       'path for photos (Drive folder + LISTING: … photos #PROCEED).' };
    }
    return { ok: false, error: 'photo pipeline failed', detail: detail.slice(-800) };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Portfolio rollup. Deliberately shaped like a Foundation Layer tile payload — when `website-it`
 * gets built it can read this off /api/state rather than inventing its own counts. Keeping the
 * rollup here (not in the browser) means the email path, the panel and later the Chief of Staff all
 * see the same numbers.
 */
function summary(listings) {
  const s = {
    total: listings.length,
    available: 0, coming_soon: 0, leased: 0, inquire: 0,
    with_photos: 0, no_photos: 0,
    buildings: 0, floor_plans: 0, units_available: 0, plans_leased: 0,
  };
  for (const l of listings) {
    if (s[l.status] !== undefined) s[l.status] += 1;
    if ((l.photos || []).length) s.with_photos += 1; else s.no_photos += 1;
    if (l.kind === 'multifamily') {
      s.buildings += 1;
      for (const p of l.floor_plans || []) {
        s.floor_plans += 1;
        if (p.status === 'leased') s.plans_leased += 1;
        else s.units_available += p.available_count || 0;
      }
    }
  }
  // Vacancy on doors we can actually count: single-family listings + multifamily units.
  const sfDoors = listings.filter((l) => l.kind !== 'multifamily').length;
  const sfVacant = listings.filter((l) => l.kind !== 'multifamily' && l.status !== 'leased').length;
  s.doors_counted = sfDoors + s.floor_plans;
  s.doors_vacant = sfVacant + s.units_available;
  s.vacancy_pct = s.doors_counted ? Math.round((s.doors_vacant / s.doors_counted) * 1000) / 10 : null;
  return s;
}

function recentAudit(n = 40) {
  try {
    return fs.readFileSync(AUDIT, 'utf8').trim().split('\n').filter(Boolean)
      .slice(-n).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ---------------------------------------------------------------- UI

const HTML = String.raw`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Iris - Website Control</title>
<style>
*{box-sizing:border-box}
body{margin:0;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#12161c;color:#e6edf3}
header{background:#1a2029;border-bottom:1px solid #2a323d;padding:13px 20px;position:sticky;top:0;z-index:20}
h1{margin:0;font-size:17px;font-weight:700}h1 span{color:#7d8896;font-weight:500}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;font-size:12px;color:#8b95a3}
.pill{background:#232b36;border:1px solid #313b48;border-radius:999px;padding:3px 10px}
.pill.warn{background:#3a2a12;border-color:#6b4a17;color:#f0c674}
.pill.ok{background:#14301f;border-color:#1f5133;color:#6bd396}
main{padding:16px 20px 240px;max-width:1180px;margin:0 auto}
.tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(340px,1fr))}
.card{background:#1a2029;border:1px solid #2a323d;border-radius:10px;padding:14px;position:relative}
.card.leased{opacity:.74}.card.dirty{border-color:#6b4a17;box-shadow:0 0 0 1px #6b4a17 inset}
.addr{font-weight:700;font-size:15px;margin:0 0 2px}
.addr a{color:inherit;text-decoration:none;border-bottom:1px dotted #4a5costs}
.meta{color:#8b95a3;font-size:12.5px;margin:0 0 10px}
.badge{display:inline-block;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;padding:3px 7px;border-radius:4px;margin-left:6px;vertical-align:1px}
.b-available,.b-coming_soon{background:#1a7f4b;color:#fff}.b-leased{background:#c0392b;color:#fff}.b-inquire{background:#5a6b7a;color:#fff}
.row{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}
label{font-size:11px;color:#7d8896;min-width:42px}
select,input,textarea{background:#12161c;color:#e6edf3;border:1px solid #313b48;border-radius:6px;padding:6px 8px;font-size:13px;font-family:inherit}
input{width:104px}input.wide,textarea{width:100%}
button{background:#2a6df4;color:#fff;border:0;border-radius:6px;padding:7px 12px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
button:hover{background:#3b7bf7}button:disabled{opacity:.4;cursor:not-allowed}
button.ghost{background:#232b36;border:1px solid #313b48}button.ghost:hover{background:#2a323d}
button.pub{background:#1a7f4b}button.pub:hover{background:#22995c}
button.sm{padding:4px 9px;font-size:12px}
.plans{margin:8px 0 2px;padding:7px 8px;background:#151b23;border:1px solid #262f3a;border-radius:7px}
.plan{margin-top:5px}.plan:first-child{margin-top:0}
.plan label{min-width:48px;font-size:11px}
.pspec{font-size:11.5px;color:#8b95a3;min-width:62px}
.plan select{font-size:12px;padding:4px 6px}
.plan input{width:74px;font-size:12px;padding:4px 6px}
#roll{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 14px;font-size:12.5px}
#roll .k{background:#1a2029;border:1px solid #2a323d;border-radius:7px;padding:7px 11px;color:#8b95a3}
#roll .k b{display:block;font-size:18px;font-weight:800;line-height:1.15;color:#e6edf3}
#roll .k.warn b{color:#f0c674}#roll .k.good b{color:#6bd396}
.drop{margin-top:9px;border:1.5px dashed #3a4552;border-radius:8px;padding:10px;text-align:center;font-size:12px;color:#7d8896;cursor:pointer}
.drop.over{border-color:#2a6df4;background:#16233a;color:#9dc0ff}
.photos{display:flex;gap:5px;margin-top:8px;flex-wrap:wrap}
.photos img{width:52px;height:40px;object-fit:cover;border-radius:4px;border:1px solid #313b48}
.tabs{position:fixed;bottom:0;left:0;right:0;background:#0d1014;border-top:1px solid #2a323d;z-index:20}
.tabhd{display:flex;gap:2px;padding:6px 20px 0}
.tabhd button{background:none;border:0;color:#7d8896;padding:6px 12px;font-size:12.5px;border-radius:6px 6px 0 0}
.tabhd button.on{background:#161b22;color:#e6edf3}
.tabbd{max-height:30vh;overflow:auto;padding:10px 20px 14px;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}
.ok{color:#6bd396}.bad{color:#ff7b72}.dim{color:#7d8896}.warn{color:#f0c674}
dialog{background:#1a2029;color:#e6edf3;border:1px solid #313b48;border-radius:10px;padding:18px;width:min(520px,92vw)}
dialog::backdrop{background:rgba(0,0,0,.6)}
dialog h3{margin:0 0 12px;font-size:15px}
.fld{display:grid;grid-template-columns:96px 1fr;gap:8px;align-items:center;margin-bottom:8px}
.fld label{min-width:0}
</style></head><body>
<header>
  <h1>Iris <span>- Website Control</span></h1>
  <div class="bar" id="bar"><span class="dim">loading...</span></div>
</header>
<main>
  <div id="roll"></div>
  <div class="tools">
    <button class="pub" id="pubBtn" disabled>Publish to live site</button>
    <input id="pubMsg" class="wide" style="max-width:330px" placeholder="what changed (optional)">
    <button class="ghost" id="reviewBtn" disabled>Review changes</button>
    <button class="ghost" id="addBtn">+ New listing</button>
    <button class="ghost" id="reload">Reload</button>
    <span style="flex:1"></span>
    <label style="min-width:0">Show</label>
    <select id="filter">
      <option value="all">all</option>
      <option value="open">available only</option>
      <option value="leased">leased only</option>
      <option value="nophoto">missing photos</option>
      <option value="dirty">unpublished only</option>
    </select>
  </div>
  <div class="grid" id="grid"></div>
</main>

<dialog id="reviewDlg"><h3>About to publish</h3>
  <div id="reviewBody" style="font:12.5px/1.7 ui-monospace,Menlo,monospace;white-space:pre-wrap"></div>
  <div class="row" style="margin-top:14px;justify-content:flex-end">
    <button class="ghost" onclick="reviewDlg.close()">Cancel</button>
    <button class="pub" id="reviewGo">Publish these</button></div>
</dialog>

<dialog id="addDlg"><h3>New listing</h3>
  <div class="fld"><label>Address</label><input id="a_addr" class="wide" placeholder="900 New St"></div>
  <div class="fld"><label>City</label><input id="a_city" class="wide" placeholder="Athens"></div>
  <div class="fld"><label>Type</label><select id="a_page" class="wide">
    <option value="single-family">single family home</option>
    <option value="apartment">apartment / multifamily</option></select></div>
  <div class="fld"><label>Beds</label><input id="a_beds" class="wide" type="number" step="0.5"></div>
  <div class="fld"><label>Baths</label><input id="a_baths" class="wide" type="number" step="0.5"></div>
  <div class="fld"><label>Sq ft</label><input id="a_sqft" class="wide" type="number"></div>
  <div class="fld"><label>Rent</label><input id="a_rent" class="wide" type="number"></div>
  <div class="fld"><label>Status</label><select id="a_status" class="wide">
    <option>available</option><option>coming_soon</option><option>leased</option><option>inquire</option></select></div>
  <p class="dim" style="font-size:12px;margin:10px 0 0">Creates it locally. Nothing goes live until you press Publish.</p>
  <div class="row" style="margin-top:12px;justify-content:flex-end">
    <button class="ghost" onclick="addDlg.close()">Cancel</button>
    <button id="addGo">Create</button></div>
</dialog>

<div class="tabs">
  <div class="tabhd">
    <button class="on" data-t="log">Activity</button>
    <button data-t="audit">History</button>
  </div>
  <div class="tabbd" id="tab-log"><span class="dim">Ready. Every action goes through the same instruction envelope the email path uses.</span></div>
  <div class="tabbd" id="tab-audit" hidden></div>
</div>

<script>
const $ = s => document.querySelector(s);
const log = (m, cls='') => { const d=document.createElement('div');
  if(cls)d.className=cls; d.textContent=new Date().toLocaleTimeString()+'  '+m; $('#tab-log').prepend(d); };
let listings=[], dirty=new Set(), review={lines:[]};

const api = (p,b) => fetch(p, b?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}:{}).then(r=>r.json());
const money = n => n==null?'-':'$'+Number(n).toLocaleString('en-US');
const esc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');

document.querySelectorAll('.tabhd button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.tabhd button').forEach(x=>x.classList.toggle('on',x===b));
  $('#tab-log').hidden = b.dataset.t!=='log';
  $('#tab-audit').hidden = b.dataset.t!=='audit';
});

function pageUrl(l){
  return 'https://echmanagement.services/' + (l.page==='apartment'
    ? 'apartment-rental-cedar-creek-lake.html' : 'single-family-home-rental-cedar-creek-lake.html');
}

function render(){
  const f = $('#filter').value;
  const show = listings.filter(l =>
    f==='all' ? true :
    f==='open' ? l.status!=='leased' :
    f==='leased' ? l.status==='leased' :
    f==='nophoto' ? !(l.photos||[]).length :
    dirty.has(l.id));
  $('#grid').innerHTML='';
  for(const l of show){
    const mf = l.kind==='multifamily';
    const c=document.createElement('div');
    c.className='card'+(l.status==='leased'?' leased':'')+(dirty.has(l.id)?' dirty':'');
    c.innerHTML =
      '<p class="addr"><a href="'+pageUrl(l)+'" target="_blank" title="view live page">'+esc(l.address)+'</a>'+
        '<span class="badge b-'+l.status+'">'+l.status.replace('_',' ')+'</span></p>'+
      '<p class="meta">'+esc(l.city)+', '+esc(l.state||'TX')+
        (mf ? ' &middot; '+l.floor_plans.length+' plan(s) &middot; '+(l.units_available||0)+' available'
            : ' &middot; '+(l.beds??'?')+'bd '+(l.baths??'?')+'ba &middot; '+money(l.rent)+'/mo')+'</p>'+
      '<div class="row"><label>Status</label><select class="st" data-id="'+l.id+'">'+
        ['available','coming_soon','leased','inquire'].map(s=>'<option'+(s===l.status?' selected':'')+'>'+s+'</option>').join('')+
      '</select>'+(mf?'':'<label>Rent</label><input class="rent" data-id="'+l.id+'" type="number" value="'+(l.rent??'')+'">')+'</div>'+
      (mf ? '<div class="plans">'+l.floor_plans.map((p,i)=>
          '<div class="row plan"><label>Plan '+(i+1)+'</label>'+
          '<span class="pspec">'+(p.beds??'?')+'bd/'+(p.baths??'?')+'ba</span>'+
          '<select class="pst" data-id="'+l.id+'" data-plan="'+(i+1)+'">'+
            ['available','leased'].map(v=>'<option'+(v===p.status?' selected':'')+'>'+v+'</option>').join('')+
          '</select>'+
          '<input class="prent" data-id="'+l.id+'" data-plan="'+(i+1)+'" type="number" placeholder="rent" value="'+(p.rent??'')+'">'+
          '<input class="pcnt" data-id="'+l.id+'" data-plan="'+(i+1)+'" type="number" min="0" title="how many of this plan are open" value="'+(p.available_count??0)+'">'+
          '<button class="psave ghost sm" data-id="'+l.id+'" data-plan="'+(i+1)+'">save</button>'+
          '</div>').join('')+'</div>' : '')+
      '<div class="row"><label>Note</label><input class="note wide" data-id="'+l.id+'" value="'+esc(l.note)+'"></div>'+
      '<div class="row"><button class="save" data-id="'+l.id+'">Apply</button>'+
        '<button class="ghost sm up" data-id="'+l.id+'">&uarr; move up</button>'+
        ((l.photos||[]).length?'<button class="ghost sm clr" data-id="'+l.id+'">clear photos</button>':'')+'</div>'+
      '<div class="drop" data-id="'+l.id+'">Drop photos here, or click to choose'+
        '<input type="file" accept="image/*" multiple hidden></div>'+
      ((l.photos||[]).length
        ? '<div class="photos">'+l.photos.map(p=>'<img src="'+p+'" alt="">').join('')+'</div>'
        : '<div class="photos"><span class="dim" style="font-size:11.5px">no photos - showing placeholder art</span></div>');
    $('#grid').append(c);
  }
  wire();
}

function wire(){
  document.querySelectorAll('.save').forEach(b=>b.onclick=async()=>{
    const id=b.dataset.id, l=listings.find(x=>x.id===id);
    const st=document.querySelector('.st[data-id="'+id+'"]').value;
    const re=document.querySelector('.rent[data-id="'+id+'"]');
    const nt=document.querySelector('.note[data-id="'+id+'"]').value;
    b.disabled=true;
    if(st!==l.status) await act('set_status',id,{status:st});
    if(re&&re.value!==''&&Number(re.value)!==l.rent) await act('set_price',id,{rent:Number(re.value)});
    if(nt!==(l.note||'')) await act('set_copy',id,{note:nt});
    b.disabled=false; await load();
  });
  document.querySelectorAll('.psave').forEach(b=>b.onclick=async()=>{
    const id=b.dataset.id, pi=Number(b.dataset.plan);
    const l=listings.find(x=>x.id===id), p=l.floor_plans[pi-1];
    const st=document.querySelector('.pst[data-id="'+id+'"][data-plan="'+pi+'"]').value;
    const rt=document.querySelector('.prent[data-id="'+id+'"][data-plan="'+pi+'"]').value;
    const ct=document.querySelector('.pcnt[data-id="'+id+'"][data-plan="'+pi+'"]').value;
    const ch={};
    if(st!==p.status) ch.status=st;
    if(rt!==''&&Number(rt)!==p.rent) ch.rent=Number(rt);
    if(ct!==''&&Number(ct)!==(p.available_count??0)) ch.count=Number(ct);
    if(!Object.keys(ch).length){ log('no change on '+id+' plan '+pi,'dim'); return; }
    b.disabled=true; await act('set_plan',id,ch,{plan_index:pi}); b.disabled=false; await load();
  });
  document.querySelectorAll('.up').forEach(b=>b.onclick=async()=>{
    const l=listings.find(x=>x.id===b.dataset.id);
    if(l.order>1){ await act('reorder',l.id,{position:l.order-1}); await load(); }
  });
  document.querySelectorAll('.clr').forEach(b=>b.onclick=async()=>{
    if(!confirm('Remove all photos from this listing? It goes back to placeholder art.'))return;
    await act('remove_photos',b.dataset.id,{clear:true}); await load();
  });
  document.querySelectorAll('.drop').forEach(d=>{
    const input=d.querySelector('input');
    d.onclick=()=>input.click();
    input.onchange=()=>{ if(input.files.length) upload(d.dataset.id,input.files); };
    d.ondragover=e=>{e.preventDefault();d.classList.add('over');};
    d.ondragleave=()=>d.classList.remove('over');
    d.ondrop=e=>{e.preventDefault();d.classList.remove('over');
      if(e.dataTransfer.files.length) upload(d.dataset.id,e.dataTransfer.files);};
  });
}

async function upload(id,files){
  const fd=new FormData();
  for(const f of files) fd.append('photo',f,f.name);
  log('uploading '+files.length+' photo(s) to '+id+' - resizing and striping GPS...','dim');
  const r=await fetch('/api/photos?listing='+encodeURIComponent(id),{method:'POST',body:fd}).then(r=>r.json());
  if(!r.ok){ log('UPLOAD FAILED  '+r.error+'  '+(r.detail||''),'bad'); return; }
  log('ok  '+r.urls.length+' photo(s) added to '+id,'ok');
  await load();
}

async function act(intent,id,changes,extra){
  const r=await api('/api/execute',Object.assign({intent,listing_id:id,changes},extra||{}));
  if(r.refused&&r.refused.length){ log('REFUSED  '+intent+' '+id+' - '+r.refused.join(' | '),'bad'); return false; }
  log('ok  '+intent+' '+id+'  '+JSON.stringify(changes),'ok'); return true;
}

async function load(){
  const d=await api('/api/state');
  listings=d.listings; dirty=new Set(d.dirty_ids||[]); review=d.review||{lines:[]};
  const g=d.git||{}, pending=review.lines.length, unpub=(g.dirtyFiles||0)+(g.ahead||0);
  $('#bar').innerHTML=
    '<span class="pill">mode: '+d.mode+'</span>'+
    '<span class="pill">sources: '+(d.live_sources||[]).join(', ')+'</span>'+
    '<span class="pill">'+listings.length+' listings</span>'+
    '<span class="pill">'+d.no_photo_count+' missing photos</span>'+
    '<span class="pill">branch: '+(g.branch||'?')+'</span>'+
    (unpub?'<span class="pill warn">'+(pending||unpub)+' change(s) not published</span>'
          :'<span class="pill ok">in sync with live site</span>');
  const S=d.summary||{};
  $('#roll').innerHTML=
    '<div class="k good"><b>'+(S.doors_vacant??'?')+'</b>doors open</div>'+
    '<div class="k"><b>'+(S.doors_counted??'?')+'</b>doors total</div>'+
    '<div class="k'+((S.vacancy_pct??0)>15?' warn':'')+'"><b>'+(S.vacancy_pct??'?')+'%</b>vacancy</div>'+
    '<div class="k"><b>'+(S.available??0)+'</b>listed available</div>'+
    '<div class="k"><b>'+(S.leased??0)+'</b>leased</div>'+
    '<div class="k"><b>'+(S.buildings??0)+'</b>bldgs / '+(S.floor_plans??0)+' plans</div>'+
    '<div class="k'+((S.no_photos??0)?' warn':' good')+'"><b>'+(S.no_photos??0)+'</b>need photos</div>';
  $('#pubBtn').disabled=!unpub; $('#reviewBtn').disabled=!pending;
  $('#tab-audit').innerHTML = (d.audit||[]).length
    ? (d.audit||[]).map(a=>{
        const t=new Date(a.at).toLocaleString();
        const cls=a.result==='refused'?'bad':a.result==='published'?'ok':'';
        return '<div class="'+cls+'">'+t+'  '+String(a.result).padEnd(9)+' '+(a.source||'')+
               '  '+(a.intent||a.message||'')+' '+(a.listing||'')+(a.reason?'  — '+a.reason:'')+'</div>';
      }).join('')
    : '<span class="dim">No history yet. Every action from every source lands here.</span>';
  render();
}

$('#reviewBtn').onclick=()=>{ $('#reviewBody').textContent=review.lines.join('\n')||'(nothing)'; reviewDlg.showModal(); };
$('#reviewGo').onclick=()=>{ reviewDlg.close(); $('#pubBtn').click(); };
$('#pubBtn').onclick=async()=>{
  $('#pubBtn').disabled=true; log('publishing...','dim');
  const r=await api('/api/publish',{message:$('#pubMsg').value});
  if(r.ok){ log('PUBLISHED '+(r.sha||'')+' - live in about a minute','ok'); $('#pubMsg').value=''; }
  else log('PUBLISH FAILED  '+(r.error||'')+'  '+(r.detail||''),'bad');
  await load();
};
$('#addBtn').onclick=()=>addDlg.showModal();
$('#addGo').onclick=async()=>{
  const addr=$('#a_addr').value.trim(), city=$('#a_city').value.trim();
  if(!addr||!city){ alert('Address and city are required.'); return; }
  const id=addr.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  const ch={page:$('#a_page').value,address:addr,city,status:$('#a_status').value};
  for(const [k,el] of [['beds','#a_beds'],['baths','#a_baths'],['sqft','#a_sqft'],['rent','#a_rent']]){
    const v=$(el).value; if(v!=='') ch[k]=Number(v);
  }
  addDlg.close();
  if(await act('create_listing',id,ch,{confirmed:true})) { log('created '+id+' - review and publish when ready','ok'); await load(); }
};
$('#reload').onclick=load; $('#filter').onchange=render;
load();
</script></body></html>`;

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const send = (code, b, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(typeof b === 'string' ? b : JSON.stringify(b));
  };

  const ra = req.socket.remoteAddress || '';
  if (!(ra.includes('127.0.0.1') || ra === '::1' || ra === '::ffff:127.0.0.1')) {
    return send(403, { error: 'local access only' });
  }

  try {
    const url = new URL(req.url, `http://${HOST}`);

    if (url.pathname === '/') return send(200, HTML, 'text/html; charset=utf-8');

    if (url.pathname === '/api/state') {
      const data = readJSON(DATA);
      const cfg = readJSON(CONFIG);
      const mode = (cfg.mode || '').toLowerCase();
      const live = mode === 'managed'
        ? (cfg.command_sources.chief_of_staff.enabled ? ['chief of staff'] : ['none'])
        : ['email (hourly)', 'control panel'];
      const listings = data.listings.slice()
        .sort((a, b) => a.page.localeCompare(b.page) || a.order - b.order);
      const review = pendingReview();
      const dirtyIds = review.lines
        .map((l) => listings.find((x) => l.includes(x.address))?.id).filter(Boolean);
      return send(200, {
        mode, live_sources: live, listings, git: gitState(), review,
        dirty_ids: dirtyIds,
        no_photo_count: listings.filter((l) => !(l.photos || []).length).length,
          summary: summary(listings),
        audit: recentAudit(40),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/execute') {
      const { intent, listing_id, changes, plan_index, confirmed } =
        JSON.parse((await body(req)).toString() || '{}');
      const target = { listing_id };
      if (plan_index != null) target.plan_index = plan_index;
      return send(200, executeEnvelope(
        envelope(intent, target, changes || {}, confirmed ? { confirmed: true } : {})));
    }

    if (req.method === 'POST' && url.pathname === '/api/photos') {
      const listing = url.searchParams.get('listing');
      if (!listing) return send(400, { ok: false, error: 'missing listing' });
      const buf = await body(req, MAX_UPLOAD);
      const files = parseMultipart(buf, req.headers['content-type']);
      if (!files.length) return send(400, { ok: false, error: 'no files received' });

      const up = uploadPhotos(listing, files);
      if (!up.ok) return send(200, up);

      // Photos are uploaded; now record them through the envelope like every other change.
      const r = executeEnvelope(envelope('add_photos', { listing_id: listing },
                                         { photo_refs: up.urls }));
      if (r.refused && r.refused.length) {
        return send(200, { ok: false, error: 'uploaded but not recorded', detail: r.refused.join(' | ') });
      }
      return send(200, { ok: true, urls: up.urls });
    }

    if (req.method === 'POST' && url.pathname === '/api/publish') {
      const { message } = JSON.parse((await body(req)).toString() || '{}');
      return send(200, publish(message));
    }

    send(404, { error: 'not found' });
  } catch (e) {
    send(500, { error: e.message });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('');
    console.log('  Iris is ALREADY RUNNING.');
    console.log('');
    console.log(`  Open it here:  http://${HOST}:${PORT}`);
    console.log('');
    console.log('  (Nothing is broken - you started it twice. Close the other black window for a');
    console.log('   fresh start, or use --port 7318 to run a second copy.)');
    console.log('');
    process.exit(0);
  }
  console.error(`  Could not start: ${err.message}`);
  process.exit(1);
});

/**
 * Last-resort guards. A single-process control panel should not die because one request threw.
 *
 * Before these, any unhandled throw in a handler took the whole server down — the browser then
 * shows ERR_CONNECTION_REFUSED, which looks like a network problem and is actually a crash. Log it,
 * keep serving. A panel that stays up and reports one broken action beats a panel that vanishes.
 */
process.on('uncaughtException', (err) => {
  console.error('');
  console.error(`  !! caught an error that would have stopped the panel: ${err.message}`);
  console.error(`     ${(err.stack || '').split('\n').slice(1, 3).join('\n     ')}`);
  console.error('     The panel is still running. Reload the page and try again.');
  console.error('');
});

process.on('unhandledRejection', (reason) => {
  console.error('');
  console.error(`  !! a background step failed: ${reason && reason.message ? reason.message : reason}`);
  console.error('     The panel is still running.');
  console.error('');
});

server.listen(PORT, HOST, () => {
  const cfg = readJSON(CONFIG);
  const lock = clearStaleGitLock();
  if (lock.cleared) {
    console.log('');
    console.log(`  note: cleared an abandoned git lock (${lock.ageSec}s old, empty).`);
    console.log('        Left behind by an earlier run that was closed mid-publish.');
  }
  console.log('');
  console.log('  Iris - Website Control');
  console.log('  ---------------------------------------------');
  console.log(`  open:      http://${HOST}:${PORT}`);
  console.log(`  mode:      ${cfg.mode}`);
  console.log(`  repo:      ${cfg.publish_target.repo}@${cfg.publish_target.branch}`);
  console.log(`  bound to:  ${HOST} only - not reachable from your network`);
  console.log('');
  console.log('  Leave this window open while you use the panel.');
  console.log('  Ctrl+C to stop.');
  console.log('');
});
