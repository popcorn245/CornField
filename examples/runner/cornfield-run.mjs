#!/usr/bin/env node
// A tiny runner helper for the cornfield agent contract (docs/agent-contract.md). No dependencies, nothing imported from cornfield:
// copy this one file next to your workflow. It is a deliberately small subset of core/agent-contract.js, tested against it.
//
//   node cornfield-run.mjs parse <comment-file>          print the request JSON of the comment's run block, or exit 1 with the reason
//   node cornfield-run.mjs stop <comment-file>           print the run id if the comment holds a stop-requested block, else exit 1
//   node cornfield-run.mjs get <json-file> <field>       print one top-level field (a string as is, anything else as JSON)
//   node cornfield-run.mjs report <runId> <state> [note] print a comment body (CORNFIELD_RUN_URL adds a log link)
//   node cornfield-run.mjs trailer <runId>               print the Cornfield-Run trailer line
// The comment file holds the comment's text. Checking that its author is a maintainer is the workflow's job, and comes first.
import { readFileSync } from 'node:fs';

const ID = /^run-[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const STATES = ['claimed', 'working', 'done', 'failed', 'stopped'];
const KINDS = ['code', 'summary', 'brief', 'proposal'];
const KEYS = ['version', 'runId', 'kind', 'profile', 'refs', 'branch', 'brief', 'limits', 'nodes', 'requestedBy', 'requestedAt'];
const BAD_KEY = /token|secret|passw|credential|api[_-]?key|access[_-]?key|private[_-]?key|ssh[_-]?key|authorization|bearer|cookie/i;
const BAD_VALUE = [/\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_\w{20,}/, /\bglpat-[\w-]{10,}/, /\bsk-[A-Za-z0-9_-]{20,}/, /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[\w-]{10,}/, /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\./, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bbearer\s+[\w.~+/-]{16,}/i, /:\/\/[^\s/@:]+:[^\s/@]+@/];
const SAFE_REF = /^(?!.*\.\.)(?!.*\/\/)(?!.*\.lock(\/|$))(?!.*\/\.)[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;

const fail = (msg) => { console.error(msg); process.exit(1); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The cornfield-run blocks of a comment as { runId, json } or { runId, error }: a fence of exactly three backticks at the start of a line, closed, and not inside another fence */
function blocks(text) {
  const out = [];
  let open = null;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^(`{3,}|~{3,})(.*)$/.exec(line);
    if (!open) { if (m) open = { ch: m[1][0], n: m[1].length, info: m[2].trim(), body: [] }; continue; }
    if (m && m[1][0] === open.ch && m[1].length >= open.n && !m[2].trim()) {
      const [tag, id, ...rest] = open.info.split(/\s+/);
      if (open.n === 3 && open.ch === '`' && tag === 'cornfield-run' && !rest.length) {
        try { out.push({ runId: id, json: JSON.parse(open.body.join('\n')) }); } catch { out.push({ runId: id, error: 'the block is not JSON' }); }
      }
      open = null;
    } else open.body.push(line);
  }
  return out;
}

function credential(v, path = '') {
  if (typeof v === 'string') return BAD_VALUE.some((re) => re.test(v)) ? path || 'value' : null;
  if (!v || typeof v !== 'object') return null;
  for (const [k, x] of Object.entries(v)) {
    if (BAD_KEY.test(k)) return `${path}${k}`;
    const hit = credential(x, `${path}${k}.`);
    if (hit) return hit;
  }
  return null;
}

function checkRequest(r, fenceId) {
  if (!ID.test(fenceId || '')) return 'the fence does not name a run id';
  if (!isObj(r)) return 'a block holds one JSON object';
  const bad = credential(r);
  if (bad) return `a request carries no credential (${bad})`;
  const extra = Object.keys(r).find((k) => !KEYS.includes(k));
  if (extra) return `unknown key ${extra}`;
  if (r.version !== 1) return 'version must be 1';
  if (r.runId !== fenceId) return 'runId differs from the run id in the fence';
  if (!KINDS.includes(r.kind)) return `kind must be one of ${KINDS.join(', ')}`;
  if (r.profile !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r.profile)) return 'profile is not a safe name';
  if (r.branch !== undefined && !(typeof r.branch === 'string' && SAFE_REF.test(r.branch) && !r.branch.endsWith('.'))) return 'branch is not a safe ref name';
  if (typeof r.brief !== 'string' || r.brief.length > 20000) return 'brief must be a string of at most 20000 characters';
  if (!isObj(r.refs)) return 'refs is required';
  if (typeof r.requestedBy !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(r.requestedBy)) return 'requestedBy is not a login';
  if (typeof r.requestedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/.test(r.requestedAt)) return 'requestedAt is not a UTC time';
  return null;
}

/** A line of prose that pings and links nobody, as the contract asks */
const defuse = (s) => String(s).replace(/[@#]/g, '$&\u200b').replace(/\b(GH)-(?=\d)/gi, '$1\u200b-').replace(/:\/\//g, ':\u200b//').replace(/\b(www)\./gi, '$1\u200b.');

const [cmd, ...args] = process.argv.slice(2);
const read = (file) => { try { return readFileSync(file, 'utf8'); } catch (e) { return fail(`cannot read ${file}: ${e.code}`); } };

if (cmd === 'parse') {
  const found = blocks(read(args[0] ?? '')).filter((b) => b.json && 'version' in b.json || b.error);
  if (!found.length) fail('no cornfield-run request block in the comment');
  const b = found[found.length - 1]; // the latest block wins
  const why = b.error ?? checkRequest(b.json, b.runId);
  if (why) fail(`refused: ${why}`);
  console.log(JSON.stringify(b.json));
} else if (cmd === 'stop') {
  const b = blocks(read(args[0] ?? '')).filter((x) => x.json?.state === 'stop-requested' && ID.test(x.runId)).pop();
  if (!b) fail('no stop request in the comment');
  console.log(b.runId);
} else if (cmd === 'get') {
  let v; try { v = JSON.parse(read(args[0] ?? ''))[args[1]]; } catch { fail('not JSON'); }
  console.log(typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));
} else if (cmd === 'report') {
  const [runId, state, note = ''] = args;
  if (!ID.test(runId ?? '')) fail('not a run id');
  if (!STATES.includes(state)) fail(`state must be one of ${STATES.join(', ')}`);
  const body = { state };
  if (note.trim()) body.note = note.trim().slice(0, 4000);
  const url = process.env.CORNFIELD_RUN_URL;
  if (url && /^https?:\/\/[^\s/@?#]+([/?#]\S*)?$/.test(url) && !credential({ url })) body.url = url;
  if (credential(body)) fail('the note looks like a credential; not posting it');
  const quoted = body.note ? `\n\n${defuse(body.note).split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')}` : '';
  console.log(`Run \`${runId}\`: ${state}.${quoted}\n\n\`\`\`cornfield-run ${runId}\n${JSON.stringify(body, null, 2)}\n\`\`\``);
} else if (cmd === 'trailer') {
  if (!ID.test(args[0] ?? '')) fail('not a run id');
  console.log(`Cornfield-Run: ${args[0]}`);
} else fail('usage: cornfield-run.mjs parse|stop|get|report|trailer ...');
