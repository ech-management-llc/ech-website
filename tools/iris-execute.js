#!/usr/bin/env node
/**
 * iris-execute.js — Iris's single entry point.
 *
 * Every command source goes through here: the email intake, the standalone control panel, and
 * (later) Foundation Layer's Chief of Staff. They all produce the same instruction envelope; this
 * consumes it. That is the whole point — swapping the source must never mean rewriting Iris.
 *
 *   node tools/iris-execute.js --envelope path/to/envelope.json
 *   node tools/iris-execute.js --envelope -            # read JSON from stdin
 *   node tools/iris-execute.js --envelope e.json --dry-run
 *   node tools/iris-execute.js --status                # report mode + who may command Iris
 *
 * Exit codes:  0 applied (or dry-run clean) · 1 refused · 2 malformed envelope · 3 config problem
 *
 * See iris/IRIS_CONTRACT.md for the envelope schema, the intent table, and the mode rules.
 * This file deliberately contains NO email logic and NO Foundation Layer logic.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'iris', 'iris.json');
const AUDIT = path.join(ROOT, 'iris', 'audit.jsonl');

const ENVELOPE_VERSION = '1.0';

/**
 * Append-only audit log. Every action Iris takes, from ANY command source, lands here.
 *
 * This lives in the executor rather than the panel on purpose: the email path and the dashboard
 * must produce the same audit trail, and later so must the Chief of Staff. One writer, one log.
 *
 * Foundation Layer requires an audit identity on every AI action (see ai_employees: "audit identity
 * + the hire-gate source of truth"). This is that, ahead of the integration — so when Iris moves
 * under FL there's already a history rather than a blank slate.
 *
 * JSONL so it's append-only and never needs rewriting: a log you have to rewrite is a log that can
 * be quietly edited.
 */
function audit(entry) {
  try {
    fs.mkdirSync(path.dirname(AUDIT), { recursive: true });
    fs.appendFileSync(AUDIT, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    // Never let an audit-write failure block or crash a real action. A missing line is bad;
    // a refused listing update because the disk hiccuped is worse.
  }
}

// ---------------------------------------------------------------- intents

/** intent -> { cli, allowed changes, publish default, needs confirmation } */
const INTENTS = {
  set_status:     { allow: ['status'],                                    publish: 'auto' },
  set_price:      { allow: ['rent'],                                      publish: 'auto' },
  set_copy:       { allow: ['note', 'badge_label'],                       publish: 'auto' },
  set_specs:      { allow: ['beds', 'baths', 'sqft'],                     publish: 'auto' },
  set_plan:       { allow: ['status', 'rent', 'count', 'beds', 'baths', 'sqft'],
                    publish: 'auto', needsPlanIndex: true },
  add_photos:     { allow: ['photo_refs'],                                publish: 'auto' },
  set_hero_photo: { allow: ['photo'],                                     publish: 'auto' },
  remove_photos:  { allow: ['photos', 'clear'],                           publish: 'auto' },
  reorder:        { allow: ['position'],                                  publish: 'auto' },
  create_listing: { allow: ['page', 'address', 'city', 'state', 'beds', 'baths', 'sqft', 'rent',
                            'status', 'note', 'tour'],                    publish: 'confirm' },
  remove_listing: { allow: [],                                            publish: 'confirm' },
};

// ---------------------------------------------------------------- plumbing

const out = { applied: [], refused: [], notes: [] };

/** Set once the envelope has parsed, so refusals can be audited with context. */
let auditCtx = null;

function refuse(reason, code = 1) {
  out.refused.push(reason);
  audit({ result: 'refused', reason, ...(auditCtx || { envelope: 'unparsed' }) });
  report();
  process.exit(code);
}

function report() {
  console.log(JSON.stringify(out, null, 2));
}

function loadConfig() {
  if (!fs.existsSync(CONFIG)) {
    out.refused.push(`iris/iris.json not found at ${CONFIG}`);
    report();
    process.exit(3);
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch (e) {
    out.refused.push(`iris/iris.json is not valid JSON: ${e.message}`);
    report();
    process.exit(3);
  }
}

/** Run a repo tool and capture output. Throws on non-zero. */
function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// ---------------------------------------------------------------- mode gate

/**
 * Which sources may command Iris right now.
 * The mode gate WINS over the per-source enabled flag — that asymmetry is deliberate. Flipping to
 * managed must stand the local sources down even if someone forgets to unset their flag.
 */
function allowedSources(cfg) {
  const mode = (cfg.mode || '').toLowerCase();
  const cs = cfg.command_sources || {};

  if (mode === 'managed') {
    return { mode, sources: cs.chief_of_staff?.enabled ? ['chief_of_staff'] : [] };
  }
  if (mode === 'standalone') {
    const list = [];
    if (cs.email?.enabled) list.push('email');
    if (cs.control_panel?.enabled) list.push('control_panel');
    return { mode, sources: list };
  }
  return { mode, sources: [] };
}

/** In managed mode Iris must never auto-publish — FL has no auto-commit branch anywhere. */
function effectivePublish(cfg, intentSpec, envelope) {
  const { mode } = allowedSources(cfg);
  if (mode === 'managed') return 'propose_only';
  if (intentSpec.publish === 'confirm') {
    return envelope.confirmed === true ? 'auto' : 'confirm';
  }
  return envelope.publish === 'propose_only' ? 'propose_only' : 'auto';
}

// ---------------------------------------------------------------- validation

function validate(env, cfg) {
  if (!env || typeof env !== 'object') refuse('envelope is not an object', 2);

  if (env.envelope_version !== ENVELOPE_VERSION) {
    refuse(`envelope_version must be "${ENVELOPE_VERSION}", got ${JSON.stringify(env.envelope_version)}`, 2);
  }

  const { mode, sources } = allowedSources(cfg);
  if (sources.length === 0) {
    refuse(`no command source is live (mode="${mode}") — Iris has no one to take orders from`, 3);
  }
  if (!env.issued_by) refuse('envelope missing issued_by', 2);
  if (!sources.includes(env.issued_by)) {
    refuse(
      `source "${env.issued_by}" may not command Iris in mode="${mode}" ` +
        `(live: ${sources.join(', ') || 'none'})`
    );
  }

  if (!env.operator) refuse('envelope missing operator — every action needs a responsible human', 2);
  if (!env.intent) refuse('envelope missing intent', 2);

  const spec = INTENTS[env.intent];
  if (!spec) refuse(`unknown intent "${env.intent}" (known: ${Object.keys(INTENTS).join(', ')})`, 2);

  const listingId = env.target?.listing_id;
  if (!listingId) refuse('envelope missing target.listing_id', 2);
  if (!/^[a-z0-9-]+$/.test(listingId)) {
    refuse(`target.listing_id must be lowercase letters, numbers and hyphens — got "${listingId}"`, 2);
  }

  if (spec.needsPlanIndex && !Number.isInteger(env.target?.plan_index)) {
    refuse(`intent "${env.intent}" requires target.plan_index (integer, 1-based)`, 2);
  }

  // Authorization is re-checked here. A source asserting verified:true is not sufficient on its own
  // — but it MUST assert it, so a missing block is a refusal rather than a silent pass.
  const auth = env.authorization || {};
  if (auth.verified !== true) {
    refuse(`authorization.verified is not true (${auth.detail || 'no detail given'})`);
  }
  if (!auth.method) refuse('authorization missing method', 2);

  const operators = cfg.command_sources?.email?.operators || [];
  if (env.issued_by === 'email' && operators.length && !operators.includes(env.operator)) {
    refuse(`operator "${env.operator}" is not in the configured operator list`);
  }

  // Unknown change keys are rejected, never ignored — silently dropping a field the caller believed
  // would apply is worse than refusing.
  const changes = env.changes || {};
  const unknown = Object.keys(changes).filter((k) => !spec.allow.includes(k));
  if (unknown.length) {
    refuse(`intent "${env.intent}" does not accept: ${unknown.join(', ')} (accepts: ${spec.allow.join(', ') || 'none'})`, 2);
  }

  const capName = {
    set_status: 'listing_status', set_price: 'listing_price',
    set_copy: 'listing_copy', set_specs: 'listing_copy',
    set_plan: 'listing_status',
    add_photos: 'listing_photos', set_hero_photo: 'listing_photos',
    remove_photos: 'listing_photos',
    reorder: 'listing_reorder',
    create_listing: 'listing_create', remove_listing: 'listing_remove',
  }[env.intent];
  const cap = (cfg.capabilities || {})[capName];
  if (cap === false) refuse(`capability "${capName}" is disabled in iris.json`);

  return spec;
}

// ---------------------------------------------------------------- envelope -> CLI

function buildArgs(env) {
  const id = env.target.listing_id;
  const c = env.changes || {};
  const flag = (k, v) => (v === undefined || v === null ? [] : [`--${k}`, String(v)]);

  switch (env.intent) {
    case 'set_status': return ['set', id, ...flag('status', c.status)];
    case 'set_price':  return ['set', id, ...flag('rent', c.rent)];
    case 'set_copy':   return ['set', id, ...flag('note', c.note), ...flag('badge_label', c.badge_label)];
    case 'set_specs':  return ['set', id, ...flag('beds', c.beds), ...flag('baths', c.baths), ...flag('sqft', c.sqft)];
    case 'set_plan':
      return ['plan', id, String(env.target.plan_index),
              ...flag('status', c.status), ...flag('rent', c.rent), ...flag('count', c.count),
              ...flag('beds', c.beds), ...flag('baths', c.baths), ...flag('sqft', c.sqft)];
    case 'set_hero_photo': return ['photos', id, '--first', String(c.photo)];
    case 'remove_photos':
      return c.clear ? ['photos', id, '--clear']
                     : ['photos', id, '--remove', ...(c.photos || []).map(String)];
    case 'reorder': return ['reorder', id, String(c.position)];
    case 'remove_listing': return ['remove', id];
    case 'create_listing': {
      const a = ['add', id];
      for (const k of ['page', 'address', 'city', 'state', 'beds', 'baths', 'sqft', 'rent', 'status', 'note', 'tour']) {
        if (c[k] !== undefined && c[k] !== null) a.push(`--${k}`, String(c[k]));
      }
      return a;
    }
    case 'add_photos':
      // photo_refs are resolved to uploaded URLs by the CALLER (photo_pipeline.py prints them).
      // Iris records URLs; she does not fetch from Drive — that belongs to the source translator.
      return ['photos', id, '--add-url', ...(c.photo_refs || []).map(String)];
    default:
      refuse(`no CLI mapping for intent "${env.intent}"`, 2);
  }
}

// ---------------------------------------------------------------- main

function main() {
  const argv = process.argv.slice(2);
  const cfg = loadConfig();

  if (argv.includes('--status')) {
    const { mode, sources } = allowedSources(cfg);
    console.log(JSON.stringify({
      employee: cfg.employee,
      reports_to: cfg.reports_to,
      mode,
      live_command_sources: sources,
      autonomy: mode === 'managed' ? cfg.autonomy?.managed_level : cfg.autonomy?.level,
      mailbox: cfg.command_sources?.email?.mailbox,
      publish_target: `${cfg.publish_target?.repo}@${cfg.publish_target?.branch}`,
      intents: Object.keys(INTENTS),
    }, null, 2));
    return;
  }

  const i = argv.indexOf('--envelope');
  if (i === -1 || !argv[i + 1]) {
    console.error('usage: iris-execute.js --envelope <file|-> [--dry-run]   |   --status');
    process.exit(2);
  }
  const src = argv[i + 1];
  const dryRun = argv.includes('--dry-run');

  let raw;
  try {
    raw = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
  } catch (e) {
    refuse(`could not read envelope: ${e.message}`, 2);
  }

  let env;
  try {
    env = JSON.parse(raw);
  } catch (e) {
    refuse(`envelope is not valid JSON: ${e.message}`, 2);
  }

  // Enough context to audit a refusal, set before validation can reject anything.
  auditCtx = {
    source: env.issued_by, operator: env.operator, intent: env.intent,
    listing: env.target?.listing_id, trace: env.trace, mode: (cfg.mode || '').toLowerCase(),
  };

  const spec = validate(env, cfg);
  const publish = effectivePublish(cfg, spec, env);

  out.notes.push(`mode=${allowedSources(cfg).mode} source=${env.issued_by} publish=${publish}`);
  if (env.trace) out.notes.push(`trace=${env.trace}`);

  if (publish === 'confirm') {
    out.refused.push(
      `intent "${env.intent}" needs explicit human confirmation — re-issue the envelope with ` +
        `"confirmed": true once the operator has approved`
    );
    report();
    process.exit(1);
  }

  const args = buildArgs(env);

  if (dryRun) {
    out.notes.push(`would run: node tools/listing-edit.js ${args.join(' ')}`);
    out.notes.push('would run: node tools/build-listings.js');
    out.notes.push(publish === 'propose_only'
      ? 'would STOP before publishing (propose_only) — a human or the Chief commits'
      : 'would publish: commit data/listings.json + changed listing pages');
    report();
    return;
  }

  try {
    out.applied.push({ step: 'listing-edit', output: run('node', ['tools/listing-edit.js', ...args]).trim() });
  } catch (e) {
    refuse(`listing-edit refused: ${(e.stderr || e.stdout || e.message).toString().trim()}`);
  }

  try {
    out.applied.push({ step: 'build', output: run('node', ['tools/build-listings.js']).trim() });
  } catch (e) {
    refuse(`build failed — listings.json changed but pages were NOT regenerated: ` +
           `${(e.stderr || e.stdout || e.message).toString().trim()}`);
  }

  out.notes.push(publish === 'propose_only'
    ? 'STOPPED before publish (propose_only). data/listings.json and the pages are staged locally; ' +
      'the Chief of Staff or a human owns the commit.'
    : 'ready to publish — caller commits data/listings.json + the changed listing pages');

  audit({ result: 'applied', publish, changes: env.changes || {}, ...auditCtx });

  report();
}

main();
