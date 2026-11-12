/**
 * @module core/config
 *
 * cornfield.config.js: what a repo tells cornfield. One ES module in the target repo's root that
 * default-exports a plain object; every key is optional. Env vars win over the file for what differs
 * per machine (the port, the host, the public URL, the data folder).
 *
 *   export default {
 *     title: 'My repo',                       // the explorer's title
 *     derivers: ['starter', 'personas', 'cloud'],   // built-in names, or './path/to/deriver.js', or { use, options }
 *     sources: {                              // browser modules for the live layer, the house and devices
 *       live: null, house: null, devices: null, checker: null,
 *     },
 *     forge: { type: 'github', url: 'https://github.com', repo: 'owner/name' },   // or type 'forgejo'; mergeMethod: 'merge' | 'squash' | 'rebase'; baseBranch: 'main'
 *     deploys: { workflows: ['*deploy*'], restarts: { 'Deploy web': ['stack-web'] } },   // which workflow runs are deploys, and what they restart (docs/deploys.md)
 *     agents: { authors: [], labels: [], branchPrefixes: [], bots: true },   // what marks work as made by an agent (docs/agents.md); and how runs are asked for and followed: transport, maxOpen, profiles, runners, quietAfter, runnerQuietAfter, limits (docs/config.md#agents)
 *     port: 3350,
 *     host: '127.0.0.1',                      // loopback, unless sign-in is configured with an https publicUrl (server/bind.js)
 *     publicUrl: null,                        // the origin people open it at; sign-in needs it (server/auth.js)
 *     worktrees: '.claude/worktrees',         // a folder of git worktrees whose unpushed proposals are listed too; or { dir, maxAgeDays } to leave out worktrees untouched that long (docs/config.md#worktrees)
 *     proposals: 'docs/specs/proposals',      // where proposal files live, in the checkout and in each worktree; or { dir, approveLands } (docs/config.md#proposals)
 *     topology: 'topology.json',
 *     personas: { roles: null },              // the roles a persona may have (null: any)
 *     releaseNotes: { breakingLabel: 'breaking' },   // the pull request label that lists a change under "Breaking" in the release notes
 *     hooks: [],                              // [{ url, events }]: signed JSON events posted to outside code (docs/config.md#hooks); the secret is env only
 *     hookPoll: { specs: '5m' },              // how often cornfield looks for ready specs and thread activity on its own, for the spec.ready and thread.* hooks; false turns it off (docs/config.md#hook-poll)
 *     threads: { label: 'idea' },             // an idea is an issue with this label, its thread the issue's comments; false turns threads off (docs/threads.md)
 *     links: [],                              // [{ label, href }] shown in the explorer's header
 *     theme: {},                              // { css, fonts, fontHosts, names, default, icons, pixelated, contrast }: a repo's own look, CSS only (docs/config.md#theme)
 *     brand: {},                              // { logo, wordmark, favicon, appName, color, background }: a repo's own logo and name, images from the repo (docs/config.md#brand)
 *     layers: {},                             // { add: [{ key, label, desc?, match }], off: [keys], order: [keys] }: a repo's own layers in the Layers menu, as data (docs/config.md#layers)
 *     strings: {},                            // { approve: 'Ship it', … }: a repo's own words for the visible labels, plain text (core/strings.js, docs/theming.md#words)
 *     embed: { origins: [] },                 // exact origins of sibling apps that may read, and decide a review, as the signed-in maintainer (docs/embedding.md)
 *     proxy: {},                              // { '/api/': 'http://127.0.0.1:3245' }: same-origin paths for a live source
 *     importMap: {},                          // bare imports a repo-local browser module needs: { name: '/repo/path.js' }
 *     dataDir: null,                          // where cornfield keeps its own state (reviews; the SQLite file in v1)
 *   }
 *
 * A source is `{ use: 'house' | './path.js', options }`: a browser module that exports `create(options)`
 * returning `{ liveSource?, floorRenderer?, checker? }`, or those names directly. Its options are sent to the
 * browser, so they never hold a secret.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { quote } from './text.js';
import { repoReader } from './repo.js';
import { themeProblems } from './theme.js';
import { brandProblems } from './brand.js';
import { stringsProblems } from './strings.js';
import { layersProblems, clientLayers } from './layers.js';
import { PROFILE_SOURCE, MAX_NUMBER, MAX_BRIEF_CHARS, RUN_KINDS, TRIGGER_EVENTS, CREDENTIAL_VALUE_SOURCE } from './agent-contract.js';

export { TRIGGER_EVENTS };

export const CONFIG_FILE = 'cornfield.config.js';
export const CORNFIELD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The derivers cornfield ships, by name */
export const BUILTIN_DERIVERS = {
  starter: 'plugins/starter/index.js',
  personas: 'plugins/personas/index.js',
  compose: 'plugins/compose/index.js',
  world: 'plugins/world/index.js',
  openapi: 'plugins/openapi/index.js',
  cloud: 'plugins/cloud/index.js',
  docs: 'plugins/docs/index.js',
};
/** The browser sources cornfield ships, by name: the module the explorer imports */
export const BUILTIN_SOURCES = {
  house: '/plugins/house/browser.js',
  // Home Assistant's registries, read by the server (plugins/house/home-assistant.js) and served like a house file
  'home-assistant': '/plugins/house/browser.js',
};
/** Options of a source the server reads and never sends to the browser */
export const SERVER_ONLY_OPTIONS = { 'home-assistant': ['file', 'url'] };
export const SOURCE_SLOTS = ['live', 'house', 'devices', 'checker'];
export const FORGE_TYPES = ['github', 'forgejo'];
/** How a pull request cornfield lands is merged (`forge.mergeMethod`): the way the repo lands its pull requests */
export const MERGE_METHODS = ['merge', 'squash', 'rebase'];
/** The events a hook may ask for (`hooks[].events`), and what each one means: docs/config.md#hooks */
export const HOOK_EVENTS = Object.freeze(['spec.ready', 'spec.approved', 'spec.sentBack', 'build.opened', 'pr.landed', 'session.expiring', 'thread.opened', 'thread.message', 'thread.linked', 'agent.requested', 'run.claimed', 'run.state', 'run.waiting', 'run.answered', 'run.stopRequested', 'run.finished', 'trigger.skipped', 'runner.offline']);
/** The events that come from looking at threads (server/threads.js): a poll that wants any of them looks at threads too */
export const THREAD_EVENTS = Object.freeze(['thread.opened', 'thread.message', 'thread.linked']);
/** The keys of `threads` when it is an object, and the label's longest length */
export const THREADS_KEYS = Object.freeze(['label']);
export const MAX_LABEL = 50;
/** The most hooks a config lists */
export const MAX_HOOKS = 20;
/** The bounds of `hookPoll.specs` in milliseconds: not under a minute (the forge is not hammered), not over an hour */
export const HOOK_POLL_MIN_MS = 60_000;
export const HOOK_POLL_MAX_MS = 3_600_000;
/** The keys of `hookPoll` when it is an object */
export const HOOK_POLL_KEYS = Object.freeze(['specs']);

/**
 * A duration like '90s', '5m' or '1h' in milliseconds, or null when it is not one (whole numbers only).
 * @param {unknown} v
 * @returns {number | null}
 */
export function parseDuration(v) {
  const m = typeof v === 'string' ? /^([1-9]\d{0,5})(s|m|h)$/.exec(v) : null;
  return m ? Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2]] : null;
}

/** Whether some hook subscribes to any of `events` (by name, or with '*') */
export function hookWants(config, events) {
  return Array.isArray(config.hooks) && config.hooks.some((h) => h.events === '*' || (Array.isArray(h.events) && h.events.some((e) => events.includes(e))));
}

/** Whether threads are on: `threads: false` turns them off, anything else (the default included) leaves them on */
export const threadsOn = (config) => config.threads !== false;

/** The label that makes an issue an idea, or null when threads are off */
export const ideaLabel = (config) => (threadsOn(config) ? (config.threads && config.threads.label) || DEFAULTS.threads.label : null);

/**
 * How often cornfield looks by itself, in milliseconds, or null when it does not: when `hookPoll.specs` is false, or no
 * hook subscribes to something the look finds (`spec.ready`, or a `thread.*` event while threads are on), by name or with '*'.
 * One look covers both: the open spec PRs and the threads (server/spec-poll.js).
 * @param {{ hooks?: { events: string[] | '*' }[], hookPoll?: { specs?: string | false } | false, threads?: false | { label?: string } }} config a loaded config
 * @returns {number | null}
 */
export function specPollMs(config) {
  const wanted = hookWants(config, ['spec.ready']) || (threadsOn(config) && (hookWants(config, THREAD_EVENTS) || triggersOf(config).some(([e]) => e === 'thread.message')));
  const every = config.hookPoll === false ? false : config.hookPoll ? config.hookPoll.specs : DEFAULTS.hookPoll.specs;
  return wanted && every !== false ? parseDuration(every ?? DEFAULTS.hookPoll.specs) : null;
}

/** How a request reaches a runner (spec 0005 D2): posted on the forge (the default), pushed as a signed `agent.requested` hook event, or kept for a runner to pull and claim */
export const AGENT_TRANSPORTS = Object.freeze(['forge', 'push', 'pull']);
/** `agents.maxOpen`: the most open runs per repo cornfield will ask for, by default and at most */
export const DEFAULT_MAX_OPEN = 3;
export const MAX_OPEN_CEILING = 100;
/** `agents.quietAfter`: how long a run may show no report, push or pull request activity before it is quiet; its bounds in milliseconds */
export const DEFAULT_QUIET_AFTER = '24h';
export const QUIET_MIN_MS = 5 * 60_000;
export const QUIET_MAX_MS = 30 * 24 * 3_600_000;
/** The most profiles and runners a config lists */
export const MAX_PROFILES = 20;
/** `agents.runnerQuietAfter`: how long no live runner token may go without polling before the runner is offline (pull transport, issue #99); its bounds in milliseconds */
export const DEFAULT_RUNNER_QUIET_AFTER = '3m';
export const RUNNER_QUIET_MIN_MS = 60_000;
export const RUNNER_QUIET_MAX_MS = 3_600_000;
export const MAX_RUNNERS = 50;

/**
 * How long a run may be silent before it is quiet, in milliseconds: `agents.quietAfter`, '24h' unless set.
 * @param {{ agents?: { quietAfter?: string } }} config a loaded config
 */
export const quietAfterMs = (config) => parseDuration(config.agents?.quietAfter ?? DEFAULT_QUIET_AFTER) ?? parseDuration(DEFAULT_QUIET_AFTER);

/** How long a runner token may go without polling before no runner is online, in milliseconds: `agents.runnerQuietAfter`, '3m' unless set */
export const runnerQuietAfterMs = (config) => parseDuration(config.agents?.runnerQuietAfter ?? DEFAULT_RUNNER_QUIET_AFTER) ?? parseDuration(DEFAULT_RUNNER_QUIET_AFTER);

export const DEFAULTS = Object.freeze({
  title: null,
  derivers: ['starter', 'personas', 'cloud'],
  sources: { live: null, house: null, devices: null, checker: null },
  forge: null,
  deploys: { workflows: ['*deploy*'], restarts: {} },
  port: 3350,
  host: '127.0.0.1',
  publicUrl: null,
  worktrees: '.claude/worktrees',
  proposals: 'docs/specs/proposals',
  topology: 'topology.json',
  personas: { roles: null, parent: 'root' },
  cloud: { parent: 'root' },
  releaseNotes: { breakingLabel: 'breaking' },
  agents: { authors: [], labels: [], branchPrefixes: [], bots: true, transport: 'forge', maxOpen: DEFAULT_MAX_OPEN, profiles: [], runners: [], quietAfter: DEFAULT_QUIET_AFTER, runnerQuietAfter: DEFAULT_RUNNER_QUIET_AFTER, limits: {}, on: {}, refuseCollisions: false, handWritten: true },
  hooks: [],
  hookPoll: { specs: '5m' },
  threads: { label: 'idea' },
  links: [],
  theme: { css: null, fonts: [], fontHosts: [], names: {}, default: null, icons: {}, pixelated: false, contrast: 'error' },
  brand: { logo: null, wordmark: null, favicon: null, appName: null, color: null, background: null },
  strings: {},
  layers: { add: [], off: [], order: [] },
  embed: { origins: [] },
  proxy: {},
  importMap: {},
  dataDir: null,
});

const KEYS = Object.keys(DEFAULTS);
/** The keys of `proposals` when it is an object: the folder, and whether an approval also lands the spec PR (opt-in, off unless true) */
export const PROPOSALS_KEYS = Object.freeze(['dir', 'approveLands']);
/** The keys of `worktrees` when it is an object: the folder, and how many days without a change leave a worktree out of the list (default: none is left out) */
export const WORKTREES_KEYS = Object.freeze(['dir', 'maxAgeDays']);
const MAX_WORKTREE_AGE_DAYS = 36500;
const AGENT_KEYS = ['authors', 'labels', 'branchPrefixes', 'bots', 'transport', 'maxOpen', 'profiles', 'runners', 'quietAfter', 'runnerQuietAfter', 'limits', 'on', 'refuseCollisions', 'handWritten', 'mirror'];
const PROFILE_NAME = new RegExp(PROFILE_SOURCE);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
/** A path inside the repo: relative, forward slashes, no `..` segment */
const inRepo = (p) => isText(p) && !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..');
/** A forge's origin: http(s), a host name or a bracketed IPv6 address, and a port; no user name, path, query, fragment or backslash */
const FORGE_ORIGIN = /^https?:\/\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?\/?$/;
/**
 * Whether `url` is a forge's origin, and one the URL parser keeps as written: a host it would rewrite to another
 * (`https://2130706433` and `https://0x7f.1` are 127.0.0.1), an IPv6 address it cannot read, or a port past 65535 is not one
 */
const isForgeOrigin = (url) => {
  const m = typeof url === 'string' ? FORGE_ORIGIN.exec(url) : null;
  if (!m) return false;
  try {
    const u = new URL(url);
    return m[1].startsWith('[') || u.hostname === m[1].toLowerCase();
  } catch { return false; }
};

/** The names a plain `http` origin may have: this machine's own (`localhost`, any `*.localhost`, `127.0.0.1`, `[::1]`) */
const isLoopbackName = (host) => host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';
const EMBED_ORIGIN = /^(https?):\/\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?$/i;
/** The most origins `embed.origins` may list: each one is trusted with the maintainer's session, so the list is short on purpose */
export const MAX_EMBED_ORIGINS = 20;

/**
 * An `embed.origins` entry as one canonical origin (`https://tasks.example.com`, `http://localhost:5173`), or what is wrong with it, in words.
 * Exact only: a scheme, a host and an optional port; no path (not even a trailing slash), query, fragment or user name, and no wildcard.
 * `https` only, except `http` for this machine's own names. The scheme and host are lowercased and a default port is dropped, so the same origin
 * written two ways is one entry. A host the URL parser would rewrite (`https://2130706433`, `https://0x7f.1`) is refused.
 * @param {unknown} value
 * @returns {{ origin: string } | { problem: string }}
 */
export function embedOrigin(value) {
  if (typeof value !== 'string' || value === '') return { problem: 'is an origin like https://tasks.example.com, as text.' };
  if (value.includes('*')) return { problem: `${quote(value)} has a wildcard: list each origin exactly, like https://tasks.example.com.` };
  if (/\s/.test(value) || value.length > 300) return { problem: `${quote(value.slice(0, 80))} is not an origin: no spaces, and at most 300 characters.` };
  if (value.includes('\\')) return { problem: `${quote(value)} has a backslash: write the origin with forward slashes, like https://tasks.example.com.` };
  if (value.includes('@')) return { problem: `${quote(value)} has a user name: an origin is a scheme, a host and a port, like https://tasks.example.com.` };
  if (!/^https?:\/\//i.test(value)) return { problem: `${quote(value)} has no https:// in front: write the whole origin, like https://tasks.example.com.` };
  if (/^https?:\/\/[^/?#]*[/?#]/i.test(value)) return { problem: `${quote(value)} has a path, query or fragment (a trailing slash counts): list the origin only, like https://tasks.example.com.` };
  const m = EMBED_ORIGIN.exec(value);
  if (!m) return { problem: `${quote(value)} is not an origin: a scheme, a host name (or a bracketed IPv6 address) and an optional port, like https://tasks.example.com.` };
  const [, scheme, host, port] = m;
  if (port !== undefined && (String(Number(port)) !== port || Number(port) < 1 || Number(port) > 65535)) return { problem: `${quote(value)} has a port that is not a number from 1 to 65535.` };
  let u;
  try { u = new URL(value.toLowerCase()); } catch { return { problem: `${quote(value)} is not a URL the browser would read as written.` }; }
  if (u.hostname !== host.toLowerCase()) return { problem: `${quote(value)} would be read as ${u.hostname}: write the host the way a browser shows it.` };
  if (scheme.toLowerCase() === 'http' && !isLoopbackName(u.hostname)) return { problem: `${quote(value)} is plain http: only https, or http for localhost, a *.localhost name, 127.0.0.1 or [::1], because the maintainer's session would otherwise be offered to a page that travels in the clear.` };
  return { origin: u.origin };
}

/** What is wrong with `embed`, in words: only `origins`, a short list of exact origins, none twice */
function embedProblems(e) {
  const out = [];
  if (e === undefined || e === null) return out;
  if (!isObject(e)) return ['"embed" is { origins: ["https://tasks.example.com"] }.'];
  for (const k of Object.keys(e)) if (k !== 'origins') out.push(`embed.${k}: the only key is origins.`);
  if (e.origins === undefined) return out;
  if (!Array.isArray(e.origins)) return [...out, 'embed.origins is a list of origins, like ["https://tasks.example.com"].'];
  if (e.origins.length > MAX_EMBED_ORIGINS) out.push(`embed.origins lists ${e.origins.length} origins; at most ${MAX_EMBED_ORIGINS}: each one is trusted with the maintainer's session.`);
  const seen = new Set();
  e.origins.forEach((o, i) => {
    const r = embedOrigin(o);
    if ('problem' in r) out.push(`embed.origins[${i}] ${r.problem}`);
    else if (seen.has(r.origin)) out.push(`embed.origins[${i}] ${quote(o)} is listed twice.`);
    else seen.add(r.origin);
  });
  return out;
}

/**
 * What is wrong with a config object (as the file exports it, before defaults).
 * @param {any} c
 * @returns {string[]}
 */
export function configProblems(c) {
  const out = [];
  if (!isObject(c)) return [`${CONFIG_FILE} must export an object (export default { … }).`];
  for (const k of Object.keys(c)) if (!KEYS.includes(k)) out.push(`unknown key ${quote(k)}. Known: ${KEYS.join(', ')}.`);
  if (c.title !== undefined && c.title !== null && !isText(c.title)) out.push('"title" is text.');
  if (c.port !== undefined && !(Number.isInteger(c.port) && c.port > 0 && c.port < 65536)) out.push('"port" is a whole number from 1 to 65535.');
  if (c.host !== undefined && !isText(c.host)) out.push('"host" is text.');
  if (c.derivers !== undefined) {
    if (!Array.isArray(c.derivers)) out.push('"derivers" is a list.');
    else c.derivers.forEach((d, i) => {
      const use = typeof d === 'string' ? d : isObject(d) ? d.use : null;
      if (!isText(use)) out.push(`derivers[${i}] is a name ("starter"), a path ("./tools/deriver.js") or { use, options }.`);
      else if (!BUILTIN_DERIVERS[use] && !use.startsWith('./')) out.push(`derivers[${i}] ${quote(use)} is not a built-in deriver (${Object.keys(BUILTIN_DERIVERS).join(', ')}) or a path starting with "./".`);
      else if (use.startsWith('./') && !inRepo(use)) out.push(`derivers[${i}] ${quote(use)} leaves the repo.`);
      if (isObject(d) && d.options !== undefined && !isObject(d.options)) out.push(`derivers[${i}].options is an object.`);
    });
  }
  if (c.sources !== undefined) {
    if (!isObject(c.sources)) out.push('"sources" is an object: { live, house, devices, checker }.');
    else for (const [slot, s] of Object.entries(c.sources)) {
      if (!SOURCE_SLOTS.includes(slot)) { out.push(`sources.${slot}: the slots are ${SOURCE_SLOTS.join(', ')}.`); continue; }
      if (s === null) continue;
      const use = typeof s === 'string' ? s : isObject(s) ? s.use : null;
      if (!isText(use)) out.push(`sources.${slot} is null, a name ("house"), a path ("./tools/live.js") or { use, options }.`);
      else if (!BUILTIN_SOURCES[use] && !use.startsWith('./')) out.push(`sources.${slot} ${quote(use)} is not a built-in source (${Object.keys(BUILTIN_SOURCES).join(', ')}) or a path starting with "./".`);
      else if (use.startsWith('./') && !inRepo(use)) out.push(`sources.${slot} ${quote(use)} leaves the repo.`);
      if (isObject(s) && s.options !== undefined) {
        if (!isObject(s.options)) out.push(`sources.${slot}.options is an object.`);
        else {
          try { JSON.stringify(s.options); } catch { out.push(`sources.${slot}.options must be plain JSON: it is sent to the browser.`); }
          if (use === 'home-assistant') {
            if ('token' in s.options) out.push(`sources.${slot}.options.token: the Home Assistant token never goes in the config; set CORNFIELD_HA_TOKEN where cornfield runs.`);
            if (s.options.url !== undefined && !/^https?:\/\/[^\s]+$/.test(String(s.options.url))) out.push(`sources.${slot}.options.url is Home Assistant's address, like http://homeassistant.local:8123.`);
          }
        }
      }
    }
  }
  if (c.forge !== undefined && c.forge !== null) {
    if (!isObject(c.forge)) out.push('"forge" is { type, url, repo }.');
    else {
      if (!FORGE_TYPES.includes(c.forge.type)) out.push(`forge.type is one of ${FORGE_TYPES.join(', ')}.`);
      if (c.forge.url !== undefined && !isForgeOrigin(c.forge.url)) out.push('forge.url is the forge\'s origin, like https://github.com.');
      // GitHub and GitHub Enterprise only speak https; a token over http would travel in the clear
      else if (c.forge.url !== undefined && c.forge.type === 'github' && !/^https:/i.test(String(c.forge.url)) && !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/i.test(String(c.forge.url))) out.push('forge.url for GitHub is https (http only for localhost): the token would otherwise travel in the clear.');
      const repoParts = String(c.forge.repo || '').split('/');
      if (!/^[\w.-]+\/[\w.-]+$/.test(String(c.forge.repo || '')) || repoParts.some((p) => /^\.+$/.test(p))) out.push('forge.repo is "owner/name".');
      if (c.forge.mergeMethod !== undefined && !MERGE_METHODS.includes(c.forge.mergeMethod)) out.push(`forge.mergeMethod is one of ${MERGE_METHODS.join(', ')}.`);
      if (c.forge.baseBranch !== undefined && !(typeof c.forge.baseBranch === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(c.forge.baseBranch) && !c.forge.baseBranch.includes('..'))) out.push('forge.baseBranch is the branch spec pull requests go into, like "main".');
    }
  }
  if (c.agents !== undefined) {
    if (!isObject(c.agents)) out.push(`"agents" is { ${AGENT_KEYS.join(', ')} }.`);
    else {
      for (const k of Object.keys(c.agents)) if (!AGENT_KEYS.includes(k)) out.push(`agents.${k}: the keys are ${AGENT_KEYS.join(', ')}.`);
      for (const k of ['authors', 'labels', 'branchPrefixes']) {
        const v = c.agents[k];
        // Account names have no spaces or commas; a label may have spaces; neither starts or ends with one
        const fine = (e) => isText(e) && e === e.trim() && (k === 'labels' || !/[\s,]/.test(e));
        if (v !== undefined && (!Array.isArray(v) || !v.every(fine))) {
          out.push(`agents.${k} is a list of ${k === 'authors' ? 'account names ("claude-bot")' : k === 'labels' ? 'label names ("agent")' : 'branch name starts ("claude/")'}.`);
        }
      }
      if (c.agents.bots !== undefined && typeof c.agents.bots !== 'boolean') out.push('agents.bots is true or false: whether a bot account ("[bot]" or the forge\'s Bot type) counts as an agent.');
      out.push(...agentRunProblems(c.agents));
      if (c.agents.handWritten === 'labeled' && c.threads === false) out.push('agents.handWritten is "labeled", which needs the threads label, and threads are off (threads: false): use true or false.');
      if (isObject(c.agents.on) && c.agents.on['thread.message'] !== undefined && c.threads === false) out.push('agents.on["thread.message"] needs threads, which are off (threads: false): the /agent command is read in a thread.');
    }
  }
  if (c.deploys !== undefined && c.deploys !== null) {
    const list = (v) => Array.isArray(v) && v.every(isText);
    if (!isObject(c.deploys)) out.push('"deploys" is { workflows, restarts }.');
    else {
      for (const k of Object.keys(c.deploys)) if (!['workflows', 'restarts'].includes(k)) out.push(`deploys.${k}: the keys are workflows, restarts.`);
      if (c.deploys.workflows !== undefined && !list(c.deploys.workflows)) out.push('deploys.workflows is a list of workflow names or patterns, like ["*deploy*"].');
      if (c.deploys.restarts !== undefined) {
        if (!isObject(c.deploys.restarts)) out.push('deploys.restarts is { "workflow name or pattern": ["node id or label"] }.');
        else for (const [p, refs] of Object.entries(c.deploys.restarts)) if (!isText(p) || !list(refs)) out.push(`deploys.restarts[${quote(p)}] is a list of node ids or labels.`);
      }
    }
  }
  if (c.hooks !== undefined) {
    if (!Array.isArray(c.hooks)) out.push('"hooks" is a list of { url, events }.');
    else {
      if (c.hooks.length > MAX_HOOKS) out.push(`"hooks" lists at most ${MAX_HOOKS} hooks.`);
      c.hooks.forEach((h, i) => {
        if (!isObject(h)) { out.push(`hooks[${i}] is { url, events }.`); return; }
        for (const k of Object.keys(h)) if (k !== 'url' && k !== 'events') out.push(`hooks[${i}].${k}: the keys are url, events (the secret is CORNFIELD_HOOK_SECRET in env, never the config).`);
        const bad = hookUrlProblem(h.url);
        if (bad) out.push(`hooks[${i}].url ${bad}`);
        if (h.events === '*') return;
        if (!Array.isArray(h.events) || h.events.length === 0) out.push(`hooks[${i}].events is "*" or a non-empty list of ${HOOK_EVENTS.join(', ')}.`);
        else {
          for (const e of h.events) if (!HOOK_EVENTS.includes(e)) out.push(`hooks[${i}].events: ${quote(e)} is not an event; the events are ${HOOK_EVENTS.join(', ')}.`);
          if (new Set(h.events).size !== h.events.length) out.push(`hooks[${i}].events names an event twice.`);
        }
      });
    }
  }
  // Push is the hook's delivery: with no hook that wants agent.requested the request would go nowhere
  if (isObject(c.agents) && c.agents.transport === 'push' && !hookWants(c, ['agent.requested'])) {
    out.push('agents.transport is "push", so a hook must subscribe to agent.requested: add { url, events: ["agent.requested"] } (or "*") to "hooks". Without one a request would go nowhere.');
  }
  if (c.hookPoll !== undefined && c.hookPoll !== false) {
    if (!isObject(c.hookPoll)) out.push('"hookPoll" is { specs: "5m" }, or false for none.');
    else {
      for (const k of Object.keys(c.hookPoll)) if (!HOOK_POLL_KEYS.includes(k)) out.push(`hookPoll.${k}: the key is ${HOOK_POLL_KEYS.join(', ')}.`);
      const v = c.hookPoll.specs;
      if (v !== undefined && v !== false) {
        const ms = parseDuration(v);
        if (ms === null) out.push('hookPoll.specs is a duration like "90s", "5m" or "1h" (from 60s to 1h), or false.');
        else if (ms < HOOK_POLL_MIN_MS) out.push(`hookPoll.specs ${quote(v)} is under the floor of 60s, so the forge is not hammered; use "60s" or more.`);
        else if (ms > HOOK_POLL_MAX_MS) out.push(`hookPoll.specs ${quote(v)} is over the ceiling of 1h; use "1h" or less, or false to turn the poll off.`);
      }
    }
  }
  if (c.threads !== undefined && c.threads !== false) {
    if (!isObject(c.threads)) out.push('"threads" is { label: "idea" }, or false to turn threads off.');
    else {
      for (const k of Object.keys(c.threads)) if (!THREADS_KEYS.includes(k)) out.push(`threads.${k}: the key is ${THREADS_KEYS.join(', ')}.`);
      const l = c.threads.label;
      if (l !== undefined && (!isText(l) || l.includes(',') || l.trim() !== l || l.length > MAX_LABEL)) out.push(`threads.label is the name of the label that makes an issue an idea, like "idea": text of at most ${MAX_LABEL} characters, no comma, no space at either end.`);
    }
  }
  if (c.releaseNotes !== undefined) {
    if (!isObject(c.releaseNotes)) out.push('"releaseNotes" is { breakingLabel }.');
    else if (c.releaseNotes.breakingLabel !== undefined && (!isText(c.releaseNotes.breakingLabel) || c.releaseNotes.breakingLabel.includes(','))) out.push('releaseNotes.breakingLabel is a label\'s name, like "breaking".');
  }
  if (c.topology !== undefined && c.topology !== null && !inRepo(c.topology)) out.push('"topology" is a folder or file inside the repo, written relative to it.');
  // The folder as a string (always so), or { dir?, maxAgeDays? }
  if (c.worktrees !== undefined && c.worktrees !== null) {
    if (isObject(c.worktrees)) {
      for (const k of Object.keys(c.worktrees)) if (!WORKTREES_KEYS.includes(k)) out.push(`worktrees.${k}: the keys are ${WORKTREES_KEYS.join(', ')}.`);
      if (c.worktrees.dir !== undefined && !inRepo(c.worktrees.dir)) out.push('worktrees.dir is the folder of git worktrees, inside the repo and written relative to it.');
      const age = c.worktrees.maxAgeDays;
      if (age !== undefined && !(typeof age === 'number' && Number.isFinite(age) && age > 0 && age <= MAX_WORKTREE_AGE_DAYS)) out.push(`worktrees.maxAgeDays is a number of days above 0 and at most ${MAX_WORKTREE_AGE_DAYS}: a worktree whose newest proposal is older is left out.`);
    } else if (!inRepo(c.worktrees)) out.push('"worktrees" is a folder inside the repo, written relative to it (or { dir, maxAgeDays }).');
  }
  // The folder as a string (always so), or { dir?, approveLands? }: the object form is how the folder's options are set
  if (c.proposals !== undefined && c.proposals !== null) {
    if (isObject(c.proposals)) {
      for (const k of Object.keys(c.proposals)) if (!PROPOSALS_KEYS.includes(k)) out.push(`proposals.${k}: the keys are ${PROPOSALS_KEYS.join(', ')}.`);
      if (c.proposals.dir !== undefined && !inRepo(c.proposals.dir)) out.push('proposals.dir is the proposals folder, inside the repo and written relative to it.');
      if (c.proposals.approveLands !== undefined && typeof c.proposals.approveLands !== 'boolean') out.push('proposals.approveLands is true or false: whether approving a spec also lands its pull request once every check is green.');
    } else if (!inRepo(c.proposals)) out.push('"proposals" is the proposals folder inside the repo, written relative to it (or { dir, approveLands }).');
  }
  if (c.links !== undefined) {
    if (!Array.isArray(c.links)) out.push('"links" is a list of { label, href }.');
    else c.links.forEach((l, i) => {
      if (!isObject(l) || !isText(l.label) || !/^(https?:\/\/|\/)/.test(String(l.href || ''))) out.push(`links[${i}] is { label, href } with an http(s) or same-origin href.`);
    });
  }
  out.push(...themeProblems(c.theme));
  out.push(...brandProblems(c.brand));
  out.push(...stringsProblems(c.strings));
  out.push(...layersProblems(c.layers));
  out.push(...embedProblems(c.embed));
  if (c.proxy !== undefined) {
    if (!isObject(c.proxy)) out.push('"proxy" is { "/path/": "http://upstream" }.');
    else for (const [p, t] of Object.entries(c.proxy)) {
      if (!/^\/[\w.-]+\/$/.test(p)) out.push(`proxy ${quote(p)}: a path like "/api/" (one segment, slashes at both ends).`);
      if (!/^https?:\/\/[^/\s]+\/?$/.test(String(t))) out.push(`proxy ${quote(p)}: the target is an origin like http://127.0.0.1:3245.`);
      if (['/cornfield/', '/proposals/', '/explorer/', '/core/', '/plugins/', '/repo/'].includes(p)) out.push(`proxy ${quote(p)} is cornfield's own path.`);
    }
  }
  if (c.importMap !== undefined && (!isObject(c.importMap) || Object.values(c.importMap).some((v) => !/^\/repo\/[\w@./-]+\.js$/.test(String(v))))) {
    out.push('"importMap" maps a bare name to a "/repo/<path>.js" module.');
  }
  if (c.personas !== undefined && (!isObject(c.personas) || (c.personas.roles != null && (!Array.isArray(c.personas.roles) || !c.personas.roles.every(isText))))) {
    out.push('"personas" is { roles: ["admin", …] | null, parent? }.');
  }
  return out;
}

/**
 * What is wrong with `agents.on`, the opt-in triggers (spec 0005 D10): `{ '<event>': { kind, profile?, brief? } }` for the events a
 * maintainer causes. Off by default (no key, no trigger). `kind` is checked against the contract and `profile` against `agents.profiles`.
 */
function triggerProblems(a) {
  const out = [];
  const on = a.on;
  if (!isObject(on)) return [`agents.on is { ${TRIGGER_EVENTS.map((e) => `"${e}": { kind, profile? }`).join(', ')} }: which events request a run by themselves (none unless set).`];
  const profiles = Array.isArray(a.profiles) ? a.profiles : [];
  for (const [event, t] of Object.entries(on)) {
    const at = `agents.on[${quote(event)}]`;
    if (!TRIGGER_EVENTS.includes(event)) { out.push(`${at}: a trigger fires only on ${TRIGGER_EVENTS.join(', ')}: something a maintainer did, never a run's output.`); continue; }
    if (!isObject(t)) { out.push(`${at} is { kind, profile?, brief? }.`); continue; }
    for (const k of Object.keys(t)) if (!['kind', 'profile', 'brief'].includes(k)) out.push(`${at}.${k}: the keys are kind, profile, brief.`);
    if (!RUN_KINDS.includes(t.kind)) out.push(`${at}.kind is one of ${RUN_KINDS.join(', ')}.`);
    if (t.profile !== undefined && !(typeof t.profile === 'string' && profiles.includes(t.profile))) out.push(`${at}.profile ${quote(t.profile)} is not one of agents.profiles (${profiles.join(', ') || 'none listed'}).`);
    if (t.brief !== undefined && !(typeof t.brief === 'string' && t.brief.length <= MAX_BRIEF_CHARS && !new RegExp(CREDENTIAL_VALUE_SOURCE).test(t.brief))) out.push(`${at}.brief is text of at most ${MAX_BRIEF_CHARS} characters, and holds nothing shaped like a credential.`);
  }
  return out;
}

/**
 * Which open issues and pull requests are read for `cornfield-run` request blocks a maintainer wrote by hand (`agents.handWritten`, issue #98):
 * `'all'` (the default, `true`), `'labeled'` (only those carrying the threads label), or `false` for none.
 * @param {{ agents?: { handWritten?: unknown } }} config
 * @returns {false | 'all' | 'labeled'}
 */
export const handWrittenMode = (config) => {
  const v = config.agents?.handWritten;
  return v === false ? false : v === 'labeled' ? 'labeled' : 'all';
};

/** The triggers a config turns on, as `[event, { kind, profile?, brief? }]` (none when off, which is the default) */
export const triggersOf = (config) => Object.entries(isObject(config.agents?.on) ? config.agents.on : {}).filter(([e]) => TRIGGER_EVENTS.includes(e));

/** What is wrong with the keys of `agents` that ask for and follow runs (spec 0005), in words */
function agentRunProblems(a) {
  const out = [];
  if (a.transport !== undefined && !AGENT_TRANSPORTS.includes(a.transport)) out.push(`agents.transport is ${AGENT_TRANSPORTS.map((t) => JSON.stringify(t)).join(', ')}: where a request goes: "forge" posts it as a comment (the default), "push" sends it as an agent.requested hook event, "pull" keeps it for a runner to claim (docs/agents.md#transports).`);
  if (a.refuseCollisions !== undefined && typeof a.refuseCollisions !== 'boolean') out.push('agents.refuseCollisions is true or false: whether a new request that names a node an open run is already changing is refused (false unless set).');
  if (a.mirror !== undefined && typeof a.mirror !== 'boolean') out.push('agents.mirror is true (the default) or false: whether cornfield keeps one status comment per run in the thread the run is about, edited as the run moves (docs/agents.md#a-thread-for-every-run).');
  if (a.handWritten !== undefined && a.handWritten !== true && a.handWritten !== false && a.handWritten !== 'labeled') out.push('agents.handWritten is true (the default: a maintainer\'s hand-written request block on any open issue or pull request becomes a run), "labeled" (only on those with the threads label) or false (cornfield follows only the runs it asked for): docs/agents.md#requests-written-by-hand.');
  if (a.maxOpen !== undefined && !(Number.isInteger(a.maxOpen) && a.maxOpen >= 1 && a.maxOpen <= MAX_OPEN_CEILING)) out.push(`agents.maxOpen is a whole number from 1 to ${MAX_OPEN_CEILING}: the most open runs cornfield asks for at once (${DEFAULT_MAX_OPEN} unless set).`);
  if (a.profiles !== undefined) {
    if (!Array.isArray(a.profiles) || a.profiles.length > MAX_PROFILES || !a.profiles.every((p) => typeof p === 'string' && PROFILE_NAME.test(p)) || new Set(a.profiles).size !== a.profiles.length) {
      out.push(`agents.profiles is a list of at most ${MAX_PROFILES} different names ("claude", "local-qwen"): letters, digits and . _ -, at most 64 characters each. The runner maps each to a model; cornfield only knows the name.`);
    }
    // agents.limits keys a profile's own limits by its name, so a profile may not be named like a limit
    else for (const p of a.profiles) if (LIMIT_NAMES.includes(p)) out.push(`agents.profiles ${quote(p)} is the name of a limit (${LIMIT_NAMES.join(', ')}); name the profile something else.`);
  }
  if (a.runners !== undefined) {
    if (!Array.isArray(a.runners) || a.runners.length > MAX_RUNNERS || !a.runners.every((r) => isText(r) && r === r.trim() && !/[\s,]/.test(r))) {
      out.push(`agents.runners is a list of at most ${MAX_RUNNERS} forge logins ("claude-bot"), the runners' own accounts whose reports count besides a maintainer's.`);
    }
  }
  if (a.quietAfter !== undefined) {
    const ms = parseDuration(a.quietAfter);
    if (ms === null) out.push('agents.quietAfter is a duration like "90m", "24h" or "72h".');
    else if (ms < QUIET_MIN_MS) out.push(`agents.quietAfter ${quote(a.quietAfter)} is under the floor of 5m; use "5m" or more.`);
    else if (ms > QUIET_MAX_MS) out.push(`agents.quietAfter ${quote(a.quietAfter)} is over the ceiling of 30 days; use "720h" or less.`);
  }
  if (a.runnerQuietAfter !== undefined) {
    const ms = parseDuration(a.runnerQuietAfter);
    if (ms === null) out.push('agents.runnerQuietAfter is a duration like "3m" or "10m": how long a runner may go without polling before it counts as offline (3m unless set).');
    else if (ms < RUNNER_QUIET_MIN_MS) out.push(`agents.runnerQuietAfter ${quote(a.runnerQuietAfter)} is under the floor of 1m; use "1m" or more.`);
    else if (ms > RUNNER_QUIET_MAX_MS) out.push(`agents.runnerQuietAfter ${quote(a.runnerQuietAfter)} is over the ceiling of 1h; use "60m" or less.`);
  }
  if (a.on !== undefined) out.push(...triggerProblems(a));
  if (a.limits !== undefined) out.push(...limitProblems(a));
  return out;
}

/** The keys of a request's `limits`, in the contract's order (core/agent-contract.js) */
export const LIMIT_NAMES = Object.freeze(['minutes', 'turns', 'cost', 'tokens']);

/** What is wrong with `agents.limits`, as lines: the flat limits for every profile, and the profiles' own (`{ claude: { cost: 5 } }`) */
function limitProblems(a) {
  const out = [];
  const say = 'agents.limits is { minutes?, turns?, cost?, tokens? } for every profile, and { <profile>: { minutes?, turns?, cost?, tokens? } } for one: hints the runner may enforce.';
  if (!isObject(a.limits)) return [say];
  const profiles = Array.isArray(a.profiles) ? a.profiles : [];
  const check = (set, at) => {
    for (const k of Object.keys(set)) if (!LIMIT_NAMES.includes(k)) out.push(`${at}.${k}: the keys are ${LIMIT_NAMES.join(', ')}.`);
    for (const k of LIMIT_NAMES) {
      const n = set[k];
      if (n === undefined) continue;
      const whole = k === 'turns' || k === 'tokens';
      if (!(typeof n === 'number' && Number.isFinite(n) && n > 0 && (!whole || (Number.isInteger(n) && n <= MAX_NUMBER)))) out.push(`${at}.${k} is a ${whole ? 'whole number' : 'number'} above zero.`);
    }
  };
  const flat = {};
  for (const [k, v] of Object.entries(a.limits)) {
    if (LIMIT_NAMES.includes(k)) { flat[k] = v; continue; }
    if (!isObject(v)) { out.push(`agents.limits.${k}: the keys are ${LIMIT_NAMES.join(', ')}, or the name of a profile with its own limits.`); continue; }
    if (!profiles.includes(k)) { out.push(`agents.limits.${k} is not one of agents.profiles (${profiles.join(', ') || 'none listed'}).`); continue; }
    check(v, `agents.limits.${k}`);
  }
  check(flat, 'agents.limits');
  return out;
}

/**
 * The limits a request starts from: the flat `agents.limits`, then the profile's own over them key by key. A request's explicit limits are
 * laid over this by the caller. Returns a new object (empty when nothing is configured).
 * @param {Record<string, any> | undefined} limits `agents.limits`
 * @param {string | undefined} profile
 */
export function limitDefaults(limits, profile) {
  const out = {};
  if (!isObject(limits)) return out;
  for (const k of LIMIT_NAMES) if (limits[k] !== undefined) out[k] = limits[k];
  const own = typeof profile === 'string' && !LIMIT_NAMES.includes(profile) ? limits[profile] : undefined;
  if (isObject(own)) for (const k of LIMIT_NAMES) if (own[k] !== undefined) out[k] = own[k];
  return out;
}

/** Whether a host is the machine itself: `localhost`, 127.x.x.x or ::1 */
const isLoopbackHost = (host) => host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);

/** What is wrong with a hook's URL, in words that follow "hooks[i].url", or null: https, or http for the machine itself; no login in it */
function hookUrlProblem(value) {
  const say = 'is an https URL, like https://chat.example.org/hooks/cornfield.';
  if (typeof value !== 'string') return say;
  let u;
  try {
    u = new URL(value);
  } catch {
    return say;
  }
  if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) return 'is https; http is only for localhost, 127.0.0.1 and [::1].';
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'is an https URL.';
  if (u.username || u.password) return 'has a user name or password in it; a hook is signed with CORNFIELD_HOOK_SECRET instead.';
  if (u.hash) return 'has a # fragment, which is never sent.';
  return null;
}

/** A short, file-safe name for a repo root, for the default data folder */
function slugOf(root) {
  return path.basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
}

/**
 * The config of the repo at `root`: the file (when there is one) over the defaults, then env vars over that.
 * @param {string} root the target repo
 * @param {{ env?: Record<string, string|undefined>, file?: string }} [opts]
 * @returns {Promise<object>} the config, with `root` and `configFile` set
 */
export async function loadConfig(root, { env = process.env, file } = {}) {
  const absRoot = path.resolve(root);
  // cornfield.config.js, or cornfield.config.mjs in a repo whose package.json is not "type": "module"
  const fallback = !fs.existsSync(path.join(absRoot, CONFIG_FILE)) && fs.existsSync(path.join(absRoot, 'cornfield.config.mjs')) ? 'cornfield.config.mjs' : CONFIG_FILE;
  const configFile = path.resolve(absRoot, file || env.CORNFIELD_CONFIG || fallback);
  let raw = {};
  if (fs.existsSync(configFile)) {
    const mod = await import(`${pathToFileURL(configFile).href}?t=${fs.statSync(configFile).mtimeMs}`);
    raw = mod.default ?? {};
    const problems = configProblems(raw);
    if (problems.length) throw new Error(`${path.relative(absRoot, configFile) || CONFIG_FILE}:\n  ${problems.join('\n  ')}`);
  }
  const config = {
    ...structuredClone({ ...DEFAULTS, sources: { ...DEFAULTS.sources }, personas: { ...DEFAULTS.personas }, cloud: { ...DEFAULTS.cloud }, agents: { ...DEFAULTS.agents }, releaseNotes: { ...DEFAULTS.releaseNotes }, threads: { ...DEFAULTS.threads } }),
    ...raw,
    sources: { ...DEFAULTS.sources, ...(raw.sources || {}) },
    personas: { ...DEFAULTS.personas, ...(raw.personas || {}) },
    cloud: { ...DEFAULTS.cloud, ...(raw.cloud || {}) },
    releaseNotes: { ...DEFAULTS.releaseNotes, ...(raw.releaseNotes || {}) },
    deploys: { ...DEFAULTS.deploys, ...(raw.deploys || {}) },
    agents: { ...DEFAULTS.agents, ...(raw.agents || {}) },
  };
  config.theme = { ...structuredClone(DEFAULTS.theme), ...(raw.theme || {}) };
  config.brand = { ...DEFAULTS.brand, ...(raw.brand || {}) };
  config.strings = { ...(raw.strings || {}) };
  config.layers = clientLayers(raw.layers); // checked above: only the known keys, as plain data
  // The origins that may embed this server, as canonical origins (checked above): [] unless the file lists some
  config.embed = { origins: (Array.isArray(raw.embed?.origins) ? raw.embed.origins : []).map((o) => /** @type {{ origin: string }} */ (embedOrigin(o)).origin) };
  // `threads: false` stays false; an object is read over the default
  config.threads = raw.threads === false ? false : { ...DEFAULTS.threads, ...(raw.threads || {}) };
  // `hookPoll: false` is `{ specs: false }`; an object is read over the default
  config.hookPoll = raw.hookPoll === false ? { specs: false } : { ...DEFAULTS.hookPoll, ...(raw.hookPoll || {}) };
  // `proposals` is the folder to everything downstream, whichever way the file wrote it; the options are read from `approveLands`
  config.approveLands = isObject(raw.proposals) && raw.proposals.approveLands === true;
  config.proposals = (isObject(raw.proposals) ? raw.proposals.dir : raw.proposals) ?? DEFAULTS.proposals;
  // `worktrees` is the folder to everything downstream (null: no worktrees are looked at); the age limit is read from `worktreeMaxAgeDays`
  config.worktreeMaxAgeDays = isObject(raw.worktrees) && raw.worktrees.maxAgeDays !== undefined ? raw.worktrees.maxAgeDays : null;
  config.worktrees = isObject(raw.worktrees) ? (raw.worktrees.dir ?? DEFAULTS.worktrees) : config.worktrees;
  if (env.CORNFIELD_PORT) config.port = Number(env.CORNFIELD_PORT);
  if (env.PORT && !env.CORNFIELD_PORT) config.port = Number(env.PORT);
  if (env.CORNFIELD_HOST) config.host = env.CORNFIELD_HOST;
  if (env.CORNFIELD_PUBLIC_URL) config.publicUrl = env.CORNFIELD_PUBLIC_URL;
  if (env.CORNFIELD_DATA) config.dataDir = env.CORNFIELD_DATA;
  // Only a Home Assistant URL and token: the house comes from Home Assistant
  if (!config.sources.house && env.CORNFIELD_HA_URL && env.CORNFIELD_HA_TOKEN) config.sources.house = { use: 'home-assistant', options: {} };
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error(`The port must be a whole number from 0 to 65535 (got ${config.port}).`);
  if (!config.title) config.title = readPackageName(absRoot) || path.basename(absRoot);
  if (!config.dataDir) config.dataDir = path.join(os.homedir(), '.cornfield', slugOf(absRoot));
  config.root = absRoot;
  config.configFile = fs.existsSync(configFile) ? configFile : null;
  return config;
}

function readPackageName(root) {
  try {
    const io = repoReader(root); // through the repo's reader: a package.json that links out of the repo is not read
    return JSON.parse(io.read('package.json')).name || null;
  } catch {
    return null;
  }
}

/**
 * The derivers a config names, loaded: `[{ deriver, options }]`.
 * @param {object} config a loaded config
 */
export async function loadDerivers(config) {
  const out = [];
  for (const entry of config.derivers) {
    const use = typeof entry === 'string' ? entry : entry.use;
    const options = (typeof entry === 'object' && entry.options) || {};
    const file = BUILTIN_DERIVERS[use] ? path.join(CORNFIELD_DIR, BUILTIN_DERIVERS[use]) : path.resolve(config.root, use);
    if (!fs.existsSync(file)) throw new Error(`Deriver ${quote(use)}: ${quote(file, { bare: true })} does not exist.`);
    const mod = await import(pathToFileURL(file).href);
    const deriver = mod.default ?? mod.deriver;
    if (!deriver) throw new Error(`Deriver ${quote(use)} (${quote(file, { bare: true })}) has no default export.`);
    out.push({ deriver, options });
  }
  return out;
}

/**
 * The sources as the browser loads them: `{ slot: { module, options } }`, with a repo-local module served under `/repo/`.
 * @param {object} config
 * @returns {Record<string, { module: string, options: object } | null>}
 */
export function browserSources(config) {
  const out = {};
  for (const slot of SOURCE_SLOTS) {
    const s = config.sources[slot];
    if (!s) { out[slot] = null; continue; }
    const use = typeof s === 'string' ? s : s.use;
    const all = (typeof s === 'object' && s.options) || {};
    const hidden = SERVER_ONLY_OPTIONS[use] || [];
    const options = Object.fromEntries(Object.entries(all).filter(([k]) => !hidden.includes(k)));
    out[slot] = { module: BUILTIN_SOURCES[use] || `/repo/${use.replace(/^\.\//, '')}`, options };
  }
  return out;
}
