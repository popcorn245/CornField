/**
 * The big map: a deterministic, seeded generator for a large, realistic repo to run cornfield at scale.
 *
 *   node test/fixtures/big/make.js --out <dir> [--seed 245] [--theme retro]
 *
 * It writes a servable repo folder (nothing in the repo holds its output; only this generator is committed):
 * `topology.json` (922 nodes, 3,632 edges, 19 node types), `topology.cloud.json`, `cornfield.config.js`, a stub file for
 * every `file` the map cites (so `cornfield validate` finds them), and about 70 proposals in docs/specs/proposals/
 * (test/fixtures/big/proposals.js). With `--theme retro` the config also names the retro brand theme.
 *
 * The same function runs in memory for the tests: `makeBig({ seed })` returns `{ files, topology, counts }` and
 * touches no disk (a theme is read from test/fixtures/themes only when asked for).
 *
 * The shape follows the sample repo: apps own pages, pages read and write tables, services belong to the API apps
 * and touch tables and outside services, stacks own containers, machines run stacks, molecules use atoms and tokens.
 * The names are invented and generic.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_THEMES } from '../../../core/schema.js';
import { missingPaths } from '../../../core/sync.js';
import { makeProposals } from './proposals.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const SEED = 245;
export const COUNTS = Object.freeze({ page: 445, table: 114, container: 73, service: 58, app: 48, external: 46, molecule: 39, pkg: 19, atom: 19, stack: 14, token: 10, tool: 8, store: 8, core: 6, persona: 5, machine: 4, rom: 3, device: 2, root: 1 });
export const NODE_TOTAL = 922;
export const EDGE_TOTAL = 3632;
export const PROPOSAL_COUNT = 70;

// ---------------------------------------------------------------------------
//  Seeded randomness
// ---------------------------------------------------------------------------

function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n) => Math.floor(next() * n);
  const pick = (list) => list[int(list.length)];
  const chance = (p) => next() < p;
  const shuffle = (list) => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  return { next, int, pick, chance, shuffle };
}

const kebab = (s) => s.replace(/_/g, '-');
const slug = (s) => s.toLowerCase().replace(/:[a-z]+/gi, (m) => m.slice(1)).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'home';

// ---------------------------------------------------------------------------
//  The vocabulary: 14 domains, 114 tables
// ---------------------------------------------------------------------------

/** domain -> its tables (114 in all); each domain has one API app that owns them */
const DOMAINS = {
  commerce: ['orders', 'order_items', 'carts', 'cart_lines', 'checkouts', 'customers', 'customer_addresses', 'wishlists'],
  billing: ['invoices', 'invoice_lines', 'payments', 'refunds', 'payouts', 'ledger_entries', 'tax_rates', 'customer_subscription_billing_adjustments', 'plans', 'subscriptions'],
  catalog: ['products', 'product_variants', 'categories', 'brands', 'collections', 'price_lists', 'product_media', 'reviews'],
  support: ['tickets', 'ticket_messages', 'macros', 'sla_policies', 'satisfaction_surveys', 'knowledge_articles', 'escalations'],
  content: ['articles', 'authors', 'pages_drafts', 'comments', 'tags', 'newsletters', 'press_releases', 'job_postings'],
  identity: ['users', 'roles', 'permissions', 'sessions', 'api_keys', 'login_attempts', 'oauth_clients', 'two_factor_devices'],
  logistics: ['shipments', 'shipment_events', 'warehouses', 'stock_levels', 'stock_movements', 'suppliers', 'purchase_orders', 'returns', 'carriers', 'pick_lists'],
  marketing: ['campaigns', 'coupons', 'segments', 'email_templates', 'campaign_sends', 'loyalty_accounts', 'loyalty_events', 'gift_cards'],
  analytics: ['page_views', 'events', 'funnels', 'dashboards', 'reports', 'report_runs', 'exports', 'metrics_daily'],
  people: ['employees', 'teams', 'departments', 'time_off_requests', 'shifts', 'timesheets', 'performance_reviews', 'training_courses'],
  devices: ['devices', 'device_groups', 'firmware_releases', 'telemetry_samples', 'camera_clips', 'alerts', 'locations'],
  ops: ['audit_events', 'feature_flags', 'webhooks', 'webhook_deliveries', 'notifications', 'jobs_runs', 'incidents', 'status_components', 'settings'],
  scheduling: ['bookings', 'appointments', 'rooms', 'availability_rules', 'calendar_events', 'reminders', 'events_listings', 'ticket_types'],
  files: ['files', 'folders', 'file_versions', 'shares', 'attachments', 'thumbnails', 'quotas'],
};

const DOMAIN_NAMES = Object.keys(DOMAINS);

/** [name, domains, weight, kind] of the 34 front apps; the 14 API apps are `api-<domain>` */
const FRONT_APPS = [
  ['shop', ['commerce', 'catalog'], 34, 'web'], ['shop-mobile', ['commerce', 'catalog'], 18, 'web'], ['checkout', ['commerce', 'billing'], 12, 'web'],
  ['account', ['identity', 'billing'], 14, 'web'], ['help-center', ['support', 'content'], 9, 'web'], ['status-page', ['ops'], 4, 'web'],
  ['blog', ['content'], 8, 'web'], ['marketplace', ['catalog', 'commerce'], 22, 'web'], ['seller-portal', ['catalog', 'logistics'], 20, 'web'],
  ['partner-portal', ['commerce', 'billing'], 10, 'web'], ['community', ['content', 'identity'], 9, 'web'], ['learning', ['people', 'content'], 8, 'web'],
  ['events', ['scheduling'], 8, 'web'], ['kiosk', ['commerce', 'devices'], 5, 'web'], ['tv-guide', ['content', 'scheduling'], 4, 'web'],
  ['returns-portal', ['logistics', 'commerce'], 7, 'web'], ['loyalty', ['marketing'], 7, 'web'], ['gift-cards', ['marketing', 'billing'], 5, 'web'],
  ['store-locator', ['logistics'], 4, 'web'], ['careers', ['content', 'people'], 4, 'web'], ['press', ['content'], 3, 'web'],
  ['docs-site', ['content'], 6, 'web'], ['developer-portal', ['identity', 'ops'], 9, 'web'], ['admin-console', ['identity', 'ops', 'commerce'], 42, 'admin'],
  ['support-desk', ['support', 'identity'], 26, 'admin'], ['warehouse-console', ['logistics'], 22, 'admin'], ['finance-console', ['billing'], 20, 'admin'],
  ['marketing-studio', ['marketing', 'analytics'], 18, 'admin'], ['analytics-board', ['analytics'], 14, 'admin'], ['people-hub', ['people'], 16, 'admin'],
  ['device-manager', ['devices'], 13, 'admin'], ['ops-center', ['ops', 'devices'], 12, 'admin'], ['schedule-board', ['scheduling', 'people'], 10, 'admin'],
  ['file-vault', ['files'], 8, 'web'],
];

const API_WEIGHT = { commerce: 14, billing: 12, catalog: 10, support: 8, content: 7, identity: 12, logistics: 10, marketing: 7, analytics: 6, people: 6, devices: 7, ops: 9, scheduling: 6, files: 6 };

const CLOUD = [
  ['stripe', 'Stripe', ['runtime', 'account'], 'Card payments, payouts and the customer portal.', 'Now: no new payment goes through and refunds queue. Orders already paid are unaffected.', 'paid'],
  ['cloudflare', 'Cloudflare', ['runtime', 'account'], 'DNS for every domain, the CDN and the tunnel.', 'Now: the sites stop resolving once cached answers expire. At the next renewal: no certificate is issued.', 'paid'],
  ['aws-s3', 'Amazon S3', ['runtime'], 'Object storage for uploads, exports and backups.', 'Now: uploads fail and exports cannot be fetched.', 'paid'],
  ['aws-ses', 'Amazon SES', ['runtime'], 'Transactional email.', 'Now: no receipts, resets or notices leave; they are retried for a day.', 'paid'],
  ['sendgrid', 'SendGrid', ['runtime'], 'Marketing email and campaign delivery.', 'Now: campaigns stall; nothing else is affected.', 'paid'],
  ['twilio', 'Twilio', ['runtime'], 'SMS codes and delivery notices.', 'Now: two-factor by text and delivery texts fail.', 'paid'],
  ['github', 'GitHub', ['software', 'account'], 'The code, its CI and its packages.', 'At the next deploy: nothing can be built or pulled.', 'paid'],
  ['docker-hub', 'Docker Hub', ['software'], 'Base images for the stacks.', 'At the next deploy: images cannot be pulled; running containers stay up.', 'free'],
  ['npm-registry', 'npm registry', ['software'], 'Packages the apps are built from.', 'At the next deploy: a clean install fails.', 'free'],
  ['sentry', 'Sentry', ['runtime'], 'Error reports from every app.', 'Now: errors are not collected; nothing user-facing breaks.', 'paid'],
  ['datadog', 'Datadog', ['runtime'], 'Metrics, logs and alerts.', 'Now: dashboards go blank and no alert pages anyone.', 'paid'],
  ['pagerduty', 'PagerDuty', ['runtime', 'account'], 'On-call paging.', 'Now: an incident pages nobody.', 'paid'],
  ['slack', 'Slack', ['runtime'], 'Chat notices from the hooks.', 'Now: chat notices are dropped.', 'free'],
  ['google-maps', 'Google Maps', ['runtime'], 'Address search and the store locator.', 'Now: the store locator and address search are empty.', 'paid'],
  ['google-analytics', 'Google Analytics', ['runtime'], 'Visitor analytics.', 'Now: visits are not counted.', 'free'],
  ['recaptcha', 'reCAPTCHA', ['runtime'], 'Bot checks on sign-up and checkout.', 'Now: sign-up and checkout forms refuse every submission.', 'free'],
  ['auth0', 'Auth0', ['runtime', 'account'], 'Social sign-in for the storefronts.', 'Now: social sign-in fails; password sign-in works.', 'paid'],
  ['algolia', 'Algolia', ['runtime'], 'Product and article search.', 'Now: search returns nothing.', 'paid'],
  ['shippo', 'Shippo', ['runtime'], 'Carrier rates and shipping labels.', 'Now: no label can be bought; packing waits.', 'paid'],
  ['avalara', 'Avalara', ['runtime'], 'Sales tax lookups.', 'Now: checkout falls back to the stored rate table.', 'paid'],
  ['quickbooks', 'QuickBooks', ['runtime', 'account'], 'The ledger the finance console exports to.', 'Now: the nightly ledger export is retried.', 'paid'],
  ['zendesk-import', 'Zendesk import', ['runtime'], 'Old tickets, read once a night.', 'Now: the import is skipped for the night.', 'off'],
  ['mapbox', 'Mapbox', ['runtime'], 'Map tiles in the device manager.', 'Now: the device map shows a grey grid.', 'free'],
  ['openai', 'A language model API', ['runtime'], 'Drafts for macros and article summaries.', 'Now: draft buttons are disabled.', 'paid'],
  ['postmark', 'Postmark', ['runtime'], 'Receipts when SES is down.', 'Now: the fallback path is unavailable.', 'unknown'],
  ['firebase-push', 'Push gateway', ['runtime'], 'Push notices to the mobile web app.', 'Now: no push notice is delivered.', 'free'],
  ['hcaptcha', 'hCaptcha', ['runtime'], 'The bot check on the press forms.', 'Now: press form submissions are refused.', 'free'],
  ['lets-encrypt', "Let's Encrypt", ['software'], 'Certificates for the self-hosted names.', 'At the next renewal: no certificate is issued.', 'free'],
  ['backblaze', 'Backblaze B2', ['runtime'], 'Off-site backups.', 'At the next backup: the copy is not made.', 'paid'],
  ['vercel', 'Vercel', ['runtime', 'account'], 'Preview deploys of the docs site.', 'At the next deploy: no preview appears.', 'free'],
  ['segment', 'Segment', ['runtime'], 'Event routing to the warehouse.', 'Now: events queue on disk.', 'paid'],
  ['bigquery', 'BigQuery', ['runtime'], 'The warehouse the analytics board reads.', 'Now: the analytics board shows the last cached day.', 'paid'],
  ['hubspot', 'HubSpot', ['runtime'], 'Leads from the partner forms.', 'Now: leads are kept locally and retried.', 'unknown'],
  ['intercom', 'Intercom', ['runtime'], 'The chat bubble in the help center.', 'Now: the bubble is missing.', 'paid'],
  ['calendly-api', 'Calendar API', ['runtime'], 'Two-way calendar sync for bookings.', 'Now: bookings stay local and sync later.', 'free'],
  ['dropbox', 'Dropbox', ['runtime'], 'An import source for the file vault.', 'Now: the import button is disabled.', 'off'],
  ['pusher', 'Pusher', ['runtime'], 'Live updates on the warehouse board.', 'Now: the board needs a manual refresh.', 'paid'],
  ['cloudinary', 'Cloudinary', ['runtime'], 'Image resizing for product media.', 'Now: original images are served, slowly.', 'free'],
  ['mailgun', 'Mailgun', ['runtime'], 'Inbound mail for support tickets.', 'Now: replies by email are not turned into messages.', 'paid'],
  ['namecheap', 'Registrar', ['account'], 'The domain registrations.', 'At renewal: a domain lapses.', 'paid'],
  ['statuspage-io', 'Status hosting', ['runtime'], 'The public status page mirror.', 'Now: the mirror is stale.', 'free'],
  ['untappd-feed', 'A partner feed', ['runtime'], 'A partner product feed read hourly.', 'Now: partner products go stale.', 'unknown'],
  ['weather-api', 'Weather API', ['runtime'], 'Forecasts for the delivery planner.', 'Now: the planner shows no forecast.', 'free'],
  ['currency-api', 'Currency rates', ['runtime'], 'Exchange rates for the marketplace.', 'Now: the last rate is used.', 'free'],
  ['exchange-rates-backup', 'Backup rates feed', ['runtime'], 'The second source of exchange rates.', 'Now: nothing, until the first one fails too.', 'unknown'],
];

const SERVICES = {
  job: ['nightly-digest', 'invoice-reminder', 'stale-cart-sweeper', 'ledger-rollup', 'thumbnail-render', 'search-reindex', 'export-builder', 'reconcile-ledger-entries-with-bank-statements-nightly'],
  client: ['geocoder', 'mailer', 'sms-gateway', 'payments-client', 'tax-client', 'shipping-rates', 'address-lookup', 'pdf-renderer'],
  dispatch: ['order-dispatch', 'notification-dispatch', 'webhook-dispatch', 'email-dispatch', 'push-dispatch', 'label-dispatch', 'task-dispatch', 'shipment-dispatch'],
  hook: ['on-order-paid', 'on-user-created', 'on-refund-issued', 'on-ticket-closed', 'on-stock-low', 'on-plan-changed', 'on-return-received', 'on-review-posted'],
  webhook: ['stripe-events', 'github-events', 'shipping-events', 'chat-events', 'calendar-events', 'files-events', 'sms-status'],
  timer: ['token-expiry', 'session-cleanup', 'trial-ending', 'cache-warmer', 'heartbeat', 'rate-limit-reset', 'quota-reset'],
  camera: ['porch-snapshots', 'dock-motion', 'shelf-timelapse', 'door-events', 'lobby-stream'],
  scheduler: ['cron-scheduler', 'queue-scheduler', 'report-scheduler', 'backup-scheduler', 'release-scheduler', 'campaign-scheduler', 'shift-scheduler'],
};

const ATOMS = ['button', 'input', 'select', 'checkbox', 'radio', 'switch', 'badge', 'avatar', 'icon', 'spinner', 'tooltip', 'tag', 'link', 'label', 'divider', 'chip', 'toggle', 'progress', 'skeleton'];
const MOLECULES = ['search-bar', 'form-field', 'date-picker', 'data-table', 'pagination', 'modal', 'toast', 'dropdown-menu', 'tabs', 'breadcrumbs', 'card', 'nav-bar', 'side-bar', 'footer', 'stepper', 'file-upload', 'address-form', 'price-tag', 'rating-stars', 'cart-line', 'order-summary', 'empty-state', 'filter-bar', 'kebab-menu', 'tree-view', 'calendar', 'timeline', 'status-banner', 'comment-box', 'user-menu', 'notification-bell', 'command-palette', 'accordion', 'carousel', 'color-picker', 'tag-input', 'avatar-group', 'stat-tile', 'code-block'];
const TOKENS = ['color', 'spacing', 'typography', 'radius', 'shadow', 'motion', 'z-index', 'breakpoints', 'density', 'opacity'];
const PKGS = ['ui', 'tokens', 'http', 'auth-client', 'forms', 'charts', 'i18n', 'validation', 'analytics', 'icons', 'router', 'cache', 'logger', 'queue', 'testing', 'pdf', 'maps', 'money', 'dates'];
const CORES = [['auth', 'Sessions, roles and the permission check'], ['router', 'Route table shared by every app'], ['i18n', 'Message catalogues and plural rules'], ['schema', 'The shapes every API call and table row follow'], ['events', 'The in-process event bus'], ['logging', 'Structured logs with request ids']];
const TOOLS = [['ci', 'CI workflows', '.github/workflows'], ['lint', 'Lint and format rules', 'tools/lint'], ['release', 'Release scripts', 'tools/release'], ['codegen', 'API client generator', 'tools/codegen'], ['migrations', 'Database migrations', 'tools/migrations'], ['fixtures', 'Seed data and fixtures', 'tools/fixtures'], ['deploy', 'Deploy scripts', 'tools/deploy'], ['bench', 'Load test scripts', 'tools/bench']];
const STORES = [['cloud', 'Cloud services', 'registry'], ['idb', 'IndexedDB', 'browser'], ['redis', 'Redis cache', 'cache'], ['objects', 'Object storage', 'server'], ['queue', 'Job queue', 'server'], ['search', 'Search index', 'server'], ['sessions', 'Session store', 'cache'], ['logs', 'Log archive', 'server']];
const PERSONAS = [['shopper', 'Shopper', 'member', 'Buys things and returns some of them.'], ['seller', 'Seller', 'member', 'Lists products and ships orders.'], ['support-agent', 'Support agent', 'admin', 'Answers tickets and issues refunds.'], ['finance-lead', 'Finance lead', 'admin', 'Closes the month and approves payouts.'], ['site-admin', 'Site admin', 'admin', 'Runs the stacks, the flags and the accounts.']];
const STACK_NAMES = ['edge', 'core', 'storefront', 'billing', 'catalog', 'support', 'content', 'identity', 'logistics', 'marketing', 'analytics', 'people', 'devices', 'ops'];
const CONTAINER_KINDS = [['web', 'node:22-alpine', [3000]], ['api', 'node:22-alpine', [3245]], ['worker', 'node:22-alpine', []], ['db', 'postgres:16', [5432]], ['cache', 'redis:7', [6379]], ['proxy', 'caddy:2', [80, 443]], ['queue', 'rabbitmq:3', [5672]], ['search', 'getmeili/meilisearch:v1', [7700]], ['mailer', 'mailhog/mailhog', [8025]], ['metrics', 'prom/prometheus', [9090]], ['storage', 'minio/minio', [9000]], ['cron', 'node:22-alpine', []]];

const PAGE_FRONT = [['/{R}', 'The {R} list.'], ['/{R}/:id', 'One of the {R}, in full.'], ['/{R}/new', 'A form to add to the {R}.'], ['/{R}/:id/edit', 'Change one of the {R}.'], ['/{R}/:id/{S}', 'The {S} of one of the {R}.'], ['/{R}/:id/{S}/:sid', 'One of the {S} of one of the {R}.'], ['/{R}/search', 'Search the {R}.'], ['/{R}/:id/{S}/:sid/edit', 'Change one of the {S} of one of the {R}.'], ['/account/{R}', 'Your own {R}.'], ['/{R}/export', 'Download the {R} as a file.']];
const PAGE_API = [['/api/v1/{R}', 'GET · POST: list and add {R}.', ['GET', 'POST']], ['/api/v1/{R}/:id', 'GET · PATCH · DELETE: one of the {R}.', ['GET', 'PATCH', 'DELETE']], ['/api/v1/{R}/:id/{S}', 'GET: the {S} of one of the {R}.', ['GET']], ['/api/v1/{R}/bulk', 'POST: change many {R} at once.', ['POST']], ['/api/v2/{R}/:id/{S}/:sid', 'GET · PUT: one of the {S} of one of the {R}.', ['GET', 'PUT']], ['/api/v1/{R}/search', 'GET: search the {R}.', ['GET']], ['/api/v1/{R}/:id/events', 'GET: what happened to one of the {R}.', ['GET']]];
const STATIC_FRONT = [['/', 'The front page.'], ['/login', 'Sign in.'], ['/search', 'Search everything.'], ['/settings', 'Your settings.'], ['/about', 'What this is.'], ['/settings/notifications/preferences/email-digest/:digestId/schedule', 'When the weekly digest is sent, and to whom, with the per-channel overrides.']];

// ---------------------------------------------------------------------------
//  The map
// ---------------------------------------------------------------------------

/** Split `total` over weights (largest remainder), each at least `min` */
function allocate(weights, total, min = 1) {
  const sum = weights.reduce((s, w) => s + w, 0);
  const raw = weights.map((w) => (w / sum) * (total - min * weights.length));
  const out = raw.map((r) => min + Math.floor(r));
  let left = total - out.reduce((s, n) => s + n, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k][1]]++;
  return out;
}

const humanize = (s) => kebab(s).replace(/-/g, ' ');

export function buildTopology(seed = SEED) {
  const R = rng(seed);
  const nodes = [];
  const byId = new Map();
  const node = (n) => {
    const theme = NODE_THEMES[n.type];
    const full = { id: n.id, label: n.label, type: n.type, r: theme.r, color: theme.color, ...Object.fromEntries(Object.entries(n).filter(([k, v]) => !['id', 'label', 'type'].includes(k) && v !== undefined)) };
    if (byId.has(full.id)) throw new Error(`duplicate id ${full.id}`);
    byId.set(full.id, full);
    nodes.push(full);
    return full;
  };
  const edges = [];
  const seen = new Set();
  const addEdge = (e) => {
    const key = `${e.from}|${e.to}|${e.kind || (e.dashed ? 'dashed' : 'own')}|${e.flow || ''}`;
    if (e.from === e.to || seen.has(key) || !byId.has(e.from) || !byId.has(e.to)) return false;
    seen.add(key);
    edges.push(e);
    return true;
  };
  const own = (from, to) => addEdge({ from, to });
  const typeOf = (id) => byId.get(id).type;

  // ---- root, stores, core, tools, packages, tokens, atoms, molecules
  node({ id: 'root', label: 'big-map', type: 'root', file: 'package.json', desc: 'big-map: a large generated repo, for trying cornfield at scale.' });
  for (const [key, label, tier] of STORES) {
    node({ id: `store-${key}`, label, type: 'store', tier, ...(key === 'cloud' ? {} : { file: `infra/stores/${key}.md` }), desc: key === 'cloud' ? 'The outside services we do not run, described in the cloud registry.' : `${label}: ${tier === 'browser' ? 'kept in the visitor\'s browser' : tier === 'cache' ? 'fast, and safe to lose' : 'durable, and backed up'}.` });
    own('root', `store-${key}`);
  }
  for (const [key, summary] of CORES) {
    node({ id: `core-${key}`, label: `core/${key}`.replace('core/', ''), type: 'core', file: `core/${key}.js`, summary, desc: `${summary}.` });
    own('root', `core-${key}`);
  }
  for (const [key, label, dir] of TOOLS) {
    node({ id: `tool-${key}`, label, type: 'tool', file: dir, desc: `${label}.`, ...(key === 'deploy' ? { url: 'https://ci.example.test/deploy' } : {}) });
    own('root', `tool-${key}`);
  }
  for (const key of PKGS) {
    node({ id: `pkg-${key}`, label: `@big/${key}`, type: 'pkg', file: `packages/${key}`, summary: `The ${humanize(key)} package`, desc: `The ${humanize(key)} package, shared by the apps.` });
    own('root', `pkg-${key}`);
  }
  for (const key of TOKENS) {
    const vars = Array.from({ length: 4 + R.int(5) }, (_, i) => `--big-${key}-${['xs', 'sm', 'md', 'lg', 'xl', 'base', 'strong', 'soft'][i]}`);
    node({ id: `token-${key}`, label: `${key} tokens`, type: 'token', file: `packages/tokens/src/${key}.css`, vars, desc: `${vars.length} design tokens: ${humanize(key)}.` });
    own('pkg-tokens', `token-${key}`);
  }
  for (const key of ATOMS) {
    const vars = [`--big-${R.pick(TOKENS)}-md`, `--big-${R.pick(TOKENS)}-sm`];
    node({ id: `atom-${key}`, label: key, type: 'atom', file: `packages/ui/src/atoms/${key}.js`, vars, desc: `The ${humanize(key)} atom.` });
    own('pkg-ui', `atom-${key}`);
  }
  for (const key of MOLECULES) {
    node({ id: `molecule-${key}`, label: key, type: 'molecule', file: `packages/ui/src/molecules/${key}.js`, ...(R.chance(0.85) ? { desc: `The ${humanize(key)} molecule: built from atoms.` } : {}) });
    own('pkg-ui', `molecule-${key}`);
  }

  // ---- apps: one API app per domain, then the front apps
  const apps = [];
  const appSlugOf = new Map();
  const mkApp = (slugName, kind, domains, weight) => {
    const host = `${slugName}.example.test`;
    const id = `app-${slugName}`;
    node({ id, label: host, type: 'app', file: `apps/${slugName}`, url: `https://${host}`, upstreams: [`${slugName}:${3000 + apps.length}`], deployed: true, desc: kind === 'api' ? `The ${domains[0]} API: the one writer of its tables.` : `${humanize(slugName)}: ${kind === 'admin' ? 'staff tools' : 'what visitors use'}.` });
    own('root', id);
    const app = { id, slug: slugName, kind, domains, weight, host };
    apps.push(app);
    appSlugOf.set(id, app);
    return app;
  };
  for (const d of DOMAIN_NAMES) mkApp(`api-${d}`, 'api', [d], API_WEIGHT[d]);
  for (const [name, domains, weight, kind] of FRONT_APPS) mkApp(name, kind, domains, weight);
  const apiApps = apps.filter((a) => a.kind === 'api');
  const frontApps = apps.filter((a) => a.kind !== 'api');
  const apiOf = (domain) => apiApps.find((a) => a.domains[0] === domain);

  // ---- tables, owned by their domain's API app
  const tableId = (t) => `table-${kebab(t)}`;
  const tablesOfDomain = {};
  for (const d of DOMAIN_NAMES) {
    tablesOfDomain[d] = [];
    for (const t of DOMAINS[d]) {
      const model = t.split('_').map((w) => w[0].toUpperCase() + w.slice(1).replace(/s$/, '')).join('');
      node({ id: tableId(t), label: t, type: 'table', table: t, model, file: `apps/api-${d}/src/models/${t}.js`, ...(R.chance(0.88) ? { desc: `The ${humanize(t)} table (${model}).` } : {}) });
      own(apiOf(d).id, tableId(t));
      tablesOfDomain[d].push(t);
    }
  }
  const allTables = DOMAIN_NAMES.flatMap((d) => tablesOfDomain[d]);

  // ---- externals: 45 cloud (one entry each in topology.cloud.json) and the public web
  const cloudFile = { version: 1, services: [], web: { label: 'Public web', desc: 'Any public page a person points the API at, such as a link preview.', breaks: 'One page down: that one preview fails and is retried.' } };
  for (const [key, label, roles, desc, breaks, tier] of CLOUD) {
    node({ id: `ext-${key}`, label, type: 'external', kind: 'cloud', file: 'topology.cloud.json', desc, roles, breaks, plan: { tier } });
    own('store-cloud', `ext-${key}`);
    cloudFile.services.push({ id: key, label, roles, desc, breaks, plan: { tier } });
  }
  node({ id: 'ext-public-web', label: 'Public web', type: 'external', kind: 'web', file: 'topology.cloud.json', desc: cloudFile.web.desc, breaks: cloudFile.web.breaks });
  own('store-cloud', 'ext-public-web');
  const cloudIds = CLOUD.map(([k]) => `ext-${k}`);

  // ---- services: 58, spread over the API apps
  const services = [];
  const kindList = Object.entries(SERVICES).flatMap(([kind, names]) => names.map((name) => ({ kind, name })));
  kindList.forEach((s, i) => {
    const app = apiApps[(i * 5 + R.int(3)) % apiApps.length];
    const id = `svc-${s.kind}-${s.name}`;
    const extra = s.kind === 'job' ? { jobs: [{ name: s.name, cron: `${R.int(60)} ${R.int(24)} * * *` }] }
      : s.kind === 'timer' ? { triggers: [`every ${[5, 15, 30, 60][R.int(4)]} minutes`] }
        : s.kind === 'scheduler' ? { triggers: ['a cron entry per job'] }
          : s.kind === 'webhook' ? { triggers: ['an outside system posts to us'] } : {};
    node({ id, label: s.name, type: 'service', kind: s.kind, file: `apps/${app.slug}/src/${s.kind}s/${s.name.slice(0, 40)}.js`, ...extra, ...(R.chance(0.9) ? { desc: `${s.kind === 'job' ? 'Runs on a schedule' : s.kind === 'client' ? 'Talks to an outside service' : s.kind === 'dispatch' ? 'Sends work out' : s.kind === 'hook' ? 'Runs when a row changes' : s.kind === 'webhook' ? 'Receives pushes' : s.kind === 'timer' ? 'Runs on an interval' : s.kind === 'camera' ? 'Reads a camera' : 'Starts other services'}: ${humanize(s.name)}.` } : {}) });
    own(app.id, id);
    services.push({ id, kind: s.kind, name: s.name, app });
  });

  // ---- pages: owned by apps, with the webhook routes of the API app's webhook services first
  const counts = allocate(apps.map((a) => a.weight), COUNTS.page, 2);
  const pages = [];
  const resourceTables = (app) => app.domains.flatMap((d) => tablesOfDomain[d]);
  apps.forEach((app, ai) => {
    const target = counts[ai];
    const made = new Set();
    const add = (label, desc, extra = {}) => {
      if (made.has(label) || made.size >= target) return false;
      made.add(label);
      const id = `page-${app.slug}-${slug(label)}`.slice(0, 100);
      const n = { id: byId.has(id) ? `${id}-${made.size}` : id, label, type: 'page', ...extra, desc: undefined };
      const file = `apps/${app.slug}/src/routes/${slug(label).slice(0, 60)}.js`;
      node({ ...n, file: R.chance(0.93) ? file : undefined, ...(R.chance(0.07) ? { url: `https://${app.host}${label.replace(/:[a-zA-Z]+/g, '1')}` } : {}), ...(R.chance(0.9) ? { desc } : {}), ...(app.kind !== 'api' && R.chance(0.15) ? { render: { now: R.pick(['build', 'request', 'build+request']), rom: 'skip' } } : {}) });
      own(app.id, n.id);
      pages.push({ id: n.id, app, label, table: extra.table || null, write: !!extra.write, resource: extra.resource || null });
      return true;
    };
    if (app.kind === 'api') {
      for (const s of services.filter((x) => x.app === app && x.kind === 'webhook')) add(`/api/v1/webhooks/${s.name}`, `POST: ${humanize(s.name)} arrive here.`, { methods: ['POST'], table: null, write: false, webhookFor: s.id });
    } else {
      for (const [label, desc] of STATIC_FRONT.slice(0, app.weight > 12 ? 6 : app.weight > 5 ? 3 : 2)) add(label, desc);
    }
    const tables = R.shuffle(resourceTables(app));
    const patterns = app.kind === 'api' ? PAGE_API : PAGE_FRONT;
    for (let round = 0; made.size < target && round < patterns.length * 2; round++) {
      const [pattern, desc, methods] = patterns[round % patterns.length];
      for (const t of tables) {
        if (made.size >= target) break;
        const sub = R.pick(tablesOfDomain[DOMAIN_NAMES.find((d) => tablesOfDomain[d].includes(t))].filter((x) => x !== t) || [t]);
        const label = pattern.replace(/\{R\}/g, kebab(t)).replace(/\{S\}/g, kebab(sub));
        const write = methods ? methods.some((m) => m !== 'GET') : /\/new$|\/edit$/.test(label);
        add(label, desc.replace(/\{R\}/g, humanize(t)).replace(/\{S\}/g, humanize(sub)), { resource: t, table: t, write, ...(methods ? { methods } : {}) });
      }
    }
    if (made.size < target) throw new Error(`could not make ${target} pages for ${app.slug}`);
  });

  // ---- stacks, containers, machines, devices, ROM, personas
  const stacks = STACK_NAMES.map((name) => ({ name, id: `stack-${name}`, file: `stacks/${name}/compose.yml`, containers: [] }));
  const machines = [['rack-1', false, 'The rack in the server room.'], ['rack-2', false, 'The second rack, for the heavy jobs.'], ['edge-1', false, 'The box at the edge that terminates TLS.'], ['vm-build-1', true, 'A build VM on the first rack.']];
  for (const [host, virtual, desc] of machines) {
    node({ id: `machine-${host}`, label: host, type: 'machine', file: 'stacks/world.json', hostname: host, ...(virtual ? { virtual: true } : {}), desc });
    own('root', `machine-${host}`);
  }
  let containerTotal = 0;
  stacks.forEach((s, si) => {
    const n = si < 3 ? 6 : 5;
    const kinds = R.shuffle(CONTAINER_KINDS).slice(0, n);
    const services = kinds.map(([svc, image, ports]) => ({ name: svc, image, ports: ports.map(String), volumes: [] }));
    node({ id: s.id, label: s.name, type: 'stack', file: s.file, services, desc: `Docker compose stack: ${services.map((x) => x.name).join(', ')}.` });
    own('root', s.id);
    for (const k of kinds) {
      const id = `container-${s.name}-${k[0]}`;
      node({ id, label: `${s.name}-${k[0]}`, type: 'container', file: s.file, stack: s.name, service: k[0], image: k[1], ports: k[2].map(String) });
      own(s.id, id);
      s.containers.push(id);
      containerTotal++;
    }
  });
  const devs = [['porch_cam', 'stack-devices', 'The porch camera.'], ['dock_cam', 'stack-logistics', 'The loading dock camera.']];
  for (const [cam, stack, desc] of devs) {
    node({ id: `device-camera-${cam}`, label: `Camera ${cam}`, type: 'device', kind: 'camera', file: `stacks/${stack.slice(6)}/compose.yml`, camera: cam, desc });
    own(`machine-rack-${cam === 'porch_cam' ? 1 : 2}`, `device-camera-${cam}`);
  }
  for (const [key, label, role, desc] of PERSONAS) {
    node({ id: `persona-${key}`, label, type: 'persona', role, desc: `Persona ${label}: role ${role}. ${desc}`, groups: [] });
    own('root', `persona-${key}`);
  }
  for (const [key, label] of [['order-receipts', 'Order receipts'], ['catalog-pages', 'Catalog pages'], ['status-snapshot', 'Status snapshot']]) {
    node({ id: `rom-${key}`, label, type: 'rom', file: `apps/api-ops/src/rom/${key}.js`, desc: `Bakes ${humanize(key)} when a row changes.` });
    own('app-api-ops', `rom-${key}`);
  }

  // ---------------------------------------------------------------------------
  //  Edges
  // ---------------------------------------------------------------------------
  const pageIds = pages.map((p) => p.id);
  const pagesOfApp = (app) => pages.filter((p) => p.app === app);
  const tableOwnerApp = (t) => apiOf(DOMAIN_NAMES.find((d) => tablesOfDomain[d].includes(t)));
  const domainOfTable = (t) => DOMAIN_NAMES.find((d) => tablesOfDomain[d].includes(t));

  // pages read and write tables
  for (const p of pages) {
    if (p.table) {
      addEdge({ from: tableId(p.table), to: p.id, kind: 'reads', status: 'live', keys: [`${p.table}/*`], label: `renders ${humanize(p.table)} rows` });
      if (p.write) addEdge({ from: p.id, to: tableId(p.table), kind: 'writes', status: 'live', label: `${p.table}.${/\/new$|POST/.test(p.label) || p.app.kind === 'api' ? 'add' : 'update'}` });
      const sibs = tablesOfDomain[domainOfTable(p.table)];
      if (R.chance(0.55)) addEdge({ from: tableId(R.pick(sibs)), to: p.id, kind: 'reads', status: 'live', keys: [`${R.pick(sibs)}/:id`], label: 'joined in the view' });
    } else if (p.app.kind !== 'api') {
      addEdge({ from: tableId(R.pick(resourceTables(p.app))), to: p.id, kind: 'reads', status: 'live', keys: ['settings/*'], label: 'renders the shell' });
    }
  }
  // app <-> API flows, apps run on stacks, stacks on machines
  for (const app of apps) {
    const stack = stacks[2 + (apps.indexOf(app) % 12)];
    byId.get(app.id).stack = stack.name;
    addEdge({ from: app.id, to: stack.id, kind: 'runs-on', label: `serves ${app.host}`, mappings: [{ host: app.host, upstream: byId.get(app.id).upstreams[0], service: stack.containers.length ? byId.get(stack.containers[0]).service : 'web' }] });
    if (app.kind !== 'api') for (const d of app.domains) addEdge({ from: app.id, to: apiOf(d).id, kind: 'flow', flow: 'api', status: 'live', label: 'the pages call the API' });
  }
  stacks.forEach((s, i) => addEdge({ from: s.id, to: `machine-${['rack-1', 'rack-2', 'edge-1'][i % 3 === 0 ? 2 : i % 2]}`, kind: 'runs-on', label: 'runs here' }));
  addEdge({ from: 'machine-vm-build-1', to: 'machine-rack-1', kind: 'runs-on', label: 'a virtual machine on its host' });
  for (const k of ['queue', 'testing', 'pdf']) addEdge({ from: `pkg-${k}`, to: R.pick(['machine-rack-2', 'machine-vm-build-1']), kind: 'runs-on', label: 'the worker runs here' });
  for (const dev of ['porch_cam', 'dock_cam']) addEdge({ from: `device-camera-${dev}`, to: R.pick(stacks.find((s) => s.name === (dev === 'porch_cam' ? 'devices' : 'logistics')).containers), kind: 'delivers', status: 'live', label: 'its video stream' });

  // services: touch tables, call each other and the outside, are started by what starts them
  const svcOf = (kind) => services.filter((s) => s.kind === kind);
  for (const s of services) {
    const domain = s.app.domains[0];
    const mine = tablesOfDomain[domain];
    for (let i = 0; i < 1 + R.int(2); i++) addEdge({ from: tableId(R.pick(mine)), to: s.id, kind: 'reads', status: 'live', keys: [`${R.pick(mine)}/*`], label: 'reads the rows it works on' });
    if (R.chance(0.6)) addEdge({ from: s.id, to: tableId(R.pick(mine)), kind: 'writes', status: 'live', label: `${R.pick(mine)}.update` });
    const outside = ['client', 'dispatch', 'webhook', 'hook'].includes(s.kind) ? 2 + R.int(3) : R.chance(0.5) ? 1 : 0;
    for (let i = 0; i < outside; i++) {
      const tgt = R.pick(cloudIds);
      addEdge({ from: s.id, to: tgt, kind: 'calls', status: 'live', label: R.pick(['sends the request', 'posts the payload', 'fetches the record', 'uploads the file']), ...(R.chance(0.25) ? { when: R.pick(['run', 'deploy', 'renew']) } : {}) });
    }
    if (s.kind === 'camera') addEdge({ from: s.id, to: R.pick(stacks.find((x) => x.name === 'devices').containers), kind: 'calls', status: 'live', label: 'reads the stream' });
    if (R.chance(0.4)) addEdge({ from: s.id, to: R.pick(services).id, kind: 'calls', status: 'live', label: 'hands work on' });
    if (s.kind === 'job' || s.kind === 'dispatch') addEdge({ from: 'store-queue', to: s.id, kind: 'triggers', status: 'live', label: 'a message is queued' });
    if (s.kind === 'hook') addEdge({ from: 'store-queue', to: s.id, kind: 'triggers', status: 'live', label: 'a change was published' });
    if (s.kind === 'webhook') {
      const page = pages.find((p) => byId.get(p.id).methods && p.label.endsWith(`/webhooks/${s.name}`));
      if (page) {
        addEdge({ from: R.pick(cloudIds), to: page.id, kind: 'delivers', status: 'live', label: 'the outside system pushes' });
        addEdge({ from: page.id, to: s.id, kind: 'triggers', status: 'live', label: 'checked, then handled' });
      }
    }
  }
  for (const sch of [...svcOf('scheduler'), ...svcOf('timer')]) for (const j of R.shuffle(svcOf('job').concat(svcOf('dispatch'))).slice(0, 2)) addEdge({ from: sch.id, to: j.id, kind: 'triggers', status: 'live', label: 'on its schedule' });
  // API endpoints call services; browsers and servers reach the outside
  for (const p of pages.filter((x) => x.app.kind === 'api')) {
    const mine = services.filter((s) => s.app === p.app);
    if (mine.length && R.chance(0.42)) addEdge({ from: p.id, to: R.pick(mine).id, kind: 'calls', status: 'live', label: 'calls' });
  }
  for (const app of apps) {
    const n = app.kind === 'api' ? 3 + R.int(3) : 1 + R.int(3);
    for (let i = 0; i < n; i++) addEdge({ from: app.id, to: R.chance(0.08) ? 'ext-public-web' : R.pick(cloudIds), kind: 'calls', status: 'live', label: R.pick(['loads the script', 'sends the request', 'fetches the data']), ...(app.kind !== 'api' && R.chance(0.5) ? { side: 'browser' } : {}) });
  }
  for (const t of TOOLS.map((x) => `tool-${x[0]}`)) addEdge({ from: t, to: R.pick(cloudIds), kind: 'calls', status: 'live', label: 'talks to it in CI' });
  for (const t of ['tool-ci', 'tool-bench', 'tool-codegen']) for (const p of R.shuffle(pageIds).slice(0, 4)) addEdge({ from: t, to: p, kind: 'calls', status: 'live', label: 'exercises' });
  for (const p of ['pkg-pdf', 'pkg-maps', 'pkg-analytics', 'core-auth']) addEdge({ from: p, to: R.pick(cloudIds), kind: 'calls', status: 'live', label: 'calls out' });
  addEdge({ from: 'root', to: 'ext-github', kind: 'calls', status: 'live', label: 'the code lives there', when: 'deploy' });
  for (const m of machines.map((x) => `machine-${x[0]}`).slice(0, 3)) addEdge({ from: m, to: 'ext-cloudflare', kind: 'calls', status: 'live', label: 'resolves the names', when: 'run' });
  for (const [s, ext] of [['edge', 'ext-lets-encrypt'], ['core', 'ext-docker-hub']]) addEdge({ from: stacks.find((x) => x.name === s).containers[0], to: ext, kind: 'calls', status: 'live', label: 'pulls from it', when: 'deploy' });
  addEdge({ from: 'ext-namecheap', to: 'ext-cloudflare', kind: 'calls', status: 'live', label: 'delegates the zone' });
  // pages reach containers (self-hosted) and containers deliver webhooks
  for (const p of R.shuffle(pages.filter((x) => x.app.kind !== 'api')).slice(0, 14)) addEdge({ from: p.id, to: R.pick(stacks.find((s) => s.name === 'core').containers), kind: 'calls', status: 'live', label: 'embeds it' });
  for (const p of R.shuffle(pages.filter((x) => x.app.kind === 'api')).slice(0, 8)) addEdge({ from: R.pick(R.pick(stacks).containers), to: p.id, kind: 'delivers', status: 'live', label: 'a change was made' });
  for (const app of R.shuffle(apps).slice(0, 8)) addEdge({ from: app.id, to: R.pick(stacks.find((s) => s.name === 'core').containers), kind: 'calls', status: 'live', label: 'uses it' });

  // design system
  for (const m of MOLECULES) {
    for (const a of R.shuffle(ATOMS).slice(0, 2 + R.int(3))) addEdge({ from: `molecule-${m}`, to: `atom-${a}`, dashed: true, label: 'uses' });
    if (R.chance(0.3)) addEdge({ from: `molecule-${m}`, to: `molecule-${R.pick(MOLECULES)}`, dashed: true, label: 'uses' });
    for (const t of R.shuffle(TOKENS).slice(0, 1 + R.int(2))) addEdge({ from: `molecule-${m}`, to: `token-${t}`, kind: 'uses', vars: [`--big-${t}-md`], label: 'reads the vars' });
  }
  for (const a of ATOMS) for (const t of R.shuffle(TOKENS).slice(0, 2 + R.int(2))) addEdge({ from: `atom-${a}`, to: `token-${t}`, kind: 'uses', vars: [`--big-${t}-sm`, `--big-${t}-md`], label: 'reads the vars' });
  for (const app of frontApps) addEdge({ from: app.id, to: `token-${R.pick(TOKENS)}`, kind: 'uses', vars: ['--big-color-base'], label: 'themes itself' });
  [['token-color', 'token-opacity'], ['token-density', 'token-spacing'], ['token-shadow', 'token-color'], ['token-motion', 'token-opacity'], ['token-typography', 'token-density'], ['token-breakpoints', 'token-spacing']].forEach(([a, b]) => addEdge({ from: a, to: b, kind: 'extends', label: 'extends' }));
  for (const app of apps) {
    const base = app.kind === 'api' ? ['http', 'validation', 'logger', 'queue', 'money', 'dates'] : ['ui', 'http', 'router', 'forms', 'i18n', 'icons', 'charts', 'analytics', 'auth-client', 'cache', 'maps'];
    for (const k of R.shuffle(base).slice(0, app.kind === 'api' ? 3 + R.int(3) : 3 + R.int(4))) addEdge({ from: app.id, to: `pkg-${k}`, dashed: true, label: 'imports' });
  }
  for (const [a, b] of [['pkg-forms', 'pkg-validation'], ['pkg-ui', 'pkg-icons'], ['pkg-charts', 'pkg-dates'], ['pkg-auth-client', 'pkg-http'], ['pkg-money', 'pkg-i18n']]) addEdge({ from: a, to: b, dashed: true, label: 'imports' });
  for (const c of CORES) for (const app of R.shuffle(apps).slice(0, 5)) addEdge({ from: app.id, to: `core-${c[0]}`, dashed: true, label: 'imports' });
  for (const p of PERSONAS) for (const app of R.shuffle(frontApps).slice(0, 3)) addEdge({ from: `persona-${p[0]}`, to: app.id, dashed: true, label: 'signs in to' });

  // data flows
  addEdge({ from: 'store-idb', to: 'app-shop', kind: 'flow', flow: 'outbox', status: 'live', label: 'the outbox sends saved changes' });
  addEdge({ from: 'store-idb', to: 'app-shop-mobile', kind: 'flow', flow: 'outbox', status: 'live', label: 'the outbox sends saved changes' });
  addEdge({ from: 'store-redis', to: 'app-api-catalog', kind: 'flow', flow: 'read', status: 'live', label: 'hot reads come from the cache' });
  addEdge({ from: 'store-search', to: 'app-api-catalog', kind: 'flow', flow: 'sync', status: 'live', label: 'the index follows the table' });
  addEdge({ from: 'table-products', to: 'store-search', kind: 'flow', flow: 'changes', status: 'live', label: 'each change is indexed' });
  addEdge({ from: 'table-orders', to: 'rom-order-receipts', kind: 'flow', flow: 'rom', status: 'live', label: 'a paid order bakes its receipt' });
  addEdge({ from: 'table-products', to: 'rom-catalog-pages', kind: 'flow', flow: 'rom', status: 'live', label: 'a product change bakes its page' });
  addEdge({ from: 'table-incidents', to: 'rom-status-snapshot', kind: 'flow', flow: 'rom', status: 'live', label: 'an incident bakes the snapshot' });
  const pageNamed = (app, label) => pages.find((p) => p.app.slug === app && p.label === label)?.id;
  for (const [rom, app, label] of [['rom-order-receipts', 'checkout', '/orders/:id'], ['rom-catalog-pages', 'shop', '/products/:id'], ['rom-status-snapshot', 'status-page', '/']]) {
    const target = pageNamed(app, label) || pagesOfApp(appSlugOf.get(`app-${app}`))[0].id;
    addEdge({ from: rom, to: target, kind: 'flow', flow: 'rom', status: 'live', label: 'serves the baked file' });
  }
  for (const s of ['store-objects', 'store-sessions', 'store-logs']) addEdge({ from: s, to: 'app-api-files', kind: 'flow', flow: 'build', status: 'live', label: 'kept for the API' });
  addEdge({ from: 'app-api-ops', to: 'store-logs', kind: 'flow', flow: 'trigger', status: 'live', label: 'ships its logs' });
  addEdge({ from: 'tool-release', to: 'tool-deploy', kind: 'flow', flow: 'model', status: 'live', label: 'the release is deployed' });

  const mandatory = edges.length;
  if (mandatory > EDGE_TOTAL) throw new Error(`the structure alone has ${mandatory} edges, over ${EDGE_TOTAL}`);

  // ---- top up to the exact count with realistic extras: pages that use molecules, read more tables, call services
  const molecules = MOLECULES.map((m) => `molecule-${m}`);
  const fillers = [
    () => { const p = R.pick(pages); return addEdge({ from: p.id, to: R.pick(molecules), dashed: true, label: 'uses' }); },
    () => { const p = R.pick(pages.filter((x) => x.app.kind !== 'api')); return addEdge({ from: tableId(R.pick(allTables)), to: p.id, kind: 'reads', status: 'live', keys: [`${R.pick(allTables)}/*`], label: 'also shown here' }); },
    () => { const p = R.pick(pages.filter((x) => x.app.kind === 'api')); const t = R.pick(tablesOfDomain[p.app.domains[0]]); return addEdge({ from: p.id, to: tableId(t), kind: 'writes', status: 'live', label: `${t}.update` }); },
    () => { const p = R.pick(pages); return addEdge({ from: p.id, to: R.pick(services).id, kind: 'calls', status: 'live', label: 'calls' }); },
    () => { const p = R.pick(pages.filter((x) => x.app.kind !== 'api')); return addEdge({ from: p.id, to: R.pick(cloudIds), kind: 'calls', status: 'live', label: 'the browser asks it', ...(R.chance(0.3) ? { when: 'run' } : {}) }); },
  ];
  let guard = 0;
  while (edges.length < EDGE_TOTAL) {
    fillers[guard % fillers.length]();
    if (++guard > 200000) throw new Error('could not reach the edge count');
  }
  if (containerTotal !== COUNTS.container) throw new Error(`containers: ${containerTotal}`);
  return { version: '1.0.0', nodes, edges, cloudFile, apps: apps.map((a) => a.id), services: services.map((s) => s.id), pages: pages.map((p) => ({ id: p.id, app: p.app.id, label: p.label })), stacks: stacks.map((s) => s.id) };
}

// ---------------------------------------------------------------------------
//  The repo
// ---------------------------------------------------------------------------

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

export function configText({ theme, retro }) {
  const lines = [
    '/** The big map\'s config: generated by test/fixtures/big/make.js, never edited by hand. */',
    'export default {',
    "  title: 'Big map',",
    '  derivers: [],',
    "  topology: 'topology.json',",
    "  proposals: 'docs/specs/proposals',",
  ];
  if (theme && retro) {
    lines.push(`  theme: ${JSON.stringify(retro.theme, null, 2).replace(/\n/g, '\n  ')},`);
    lines.push(`  brand: ${JSON.stringify(retro.brand, null, 2).replace(/\n/g, '\n  ')},`);
  }
  lines.push('};', '');
  return lines.join('\n');
}

/** What the retro theme adds to a config, and the files it needs in the repo (read from test/fixtures/themes/retro) */
export function retroTheme(dir = path.join(HERE, '..', 'themes', 'retro')) {
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  const files = {};
  for (const f of fs.readdirSync(dir)) if (f !== 'config.json' && f !== 'README.md') files[`tools/cornfield/${f}`] = fs.readFileSync(path.join(dir, f), 'utf8');
  return { theme: cfg.theme, brand: cfg.brand, files };
}

const folderSet = (paths) => new Set(paths.flatMap((f) => f.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));

/**
 * The files of a servable repo for any topology: the map, its cloud and personas files when it has them, a config, a stub for
 * every path the map cites (so `cornfield validate` finds them), and the proposals made from it.
 * @param {{ topology: any, cloud?: any, personas?: any, theme?: string|null, seed?: number }} opts
 */
export function repoFiles({ topology, cloud = null, personas = null, theme = null, seed = SEED }) {
  const retro = theme ? retroTheme() : null;
  const files = {
    'package.json': json({ name: 'big-map', version: '0.0.0', private: true, type: 'module' }),
    'topology.json': json({ version: '1.0.0', ...topology }),
    'cornfield.config.js': configText({ theme, retro }),
  };
  if (cloud) files['topology.cloud.json'] = json(cloud);
  if (personas) files['topology.personas.json'] = json(personas);
  if (retro) Object.assign(files, retro.files);
  const proposals = makeProposals(topology, { seed });
  for (const [name, text] of Object.entries(proposals)) files[`docs/specs/proposals/${name}`] = text;
  // a stub for every path the map cites: first each node's file, then what a description cites that is still missing
  const cited = new Map();
  for (const n of topology.nodes) for (const f of String(n.file || '').split(/,\s*/).filter(Boolean)) if (!(f in files) && !cited.has(f)) cited.set(f, `${n.type}: ${n.label}`);
  const settle = () => {
    const folders = folderSet([...cited.keys(), ...Object.keys(files)]);
    for (const [f, what] of cited) {
      if (f in files) continue;
      if (folders.has(f)) { if (f !== 'docs/specs/proposals') files[`${f}/package.json`] = json({ name: f.split('/').pop(), private: true }); }
      else files[f] = f.endsWith('.json') ? '{}\n' : `// ${what}\n`;
    }
  };
  settle();
  for (let round = 0; round < 3; round++) {
    const all = new Set([...Object.keys(files), ...folderSet(Object.keys(files))]);
    const more = missingPaths(topology, all).map((m) => /"([^"]+)", which|cites (\S+), which/.exec(m)).filter(Boolean).map((m) => m[1] || m[2]);
    if (!more.length) break;
    for (const f of more) if (!cited.has(f)) cited.set(f, 'cited');
    settle();
  }
  // a stub that turned out to be a folder (another stub is under it) becomes the folder's package.json
  const dirs = folderSet(Object.keys(files));
  for (const f of Object.keys(files)) if (dirs.has(f)) { delete files[f]; if (f !== 'docs/specs/proposals') files[`${f}/package.json`] ??= json({ name: f.split('/').pop(), private: true }); }
  return { files, proposals: Object.keys(proposals).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')) };
}

/**
 * The whole synthetic repo, in memory.
 * @param {{ seed?: number, theme?: string|null }} [opts]
 * @returns {{ files: Record<string, string>, topology: any, counts: Record<string, number>, proposals: string[], themeName: string|null }}
 */
export function makeBig({ seed = SEED, theme = null } = {}) {
  if (theme && theme !== 'retro') throw new Error(`unknown theme "${theme}" (there is one: retro)`);
  const topo = buildTopology(seed);
  const topology = { version: '1.0.0', nodes: topo.nodes, edges: topo.edges };
  const { files, proposals } = repoFiles({ topology, cloud: topo.cloudFile, theme, seed });
  files['stacks/world.json'] = json({ machines: topo.nodes.filter((n) => n.type === 'machine').map((m) => ({ hostname: m.hostname })) });
  const counts = {};
  for (const n of topo.nodes) counts[n.type] = (counts[n.type] || 0) + 1;
  return { files, topology, counts, proposals, themeName: theme };
}

/** The repo of an existing topology folder (topology.json, and topology.cloud.json and topology.personas.json when present): read, never changed */
export function makeFrom(dir, { seed = SEED, theme = null } = {}) {
  if (theme && theme !== 'retro') throw new Error(`unknown theme "${theme}" (there is one: retro)`);
  const read = (name) => { const f = path.join(dir, name); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
  const topology = read('topology.json');
  if (!topology) throw new Error(`${path.join(dir, 'topology.json')} is not there`);
  const { files, proposals } = repoFiles({ topology, cloud: read('topology.cloud.json'), personas: read('topology.personas.json'), theme, seed });
  const counts = {};
  for (const n of topology.nodes) counts[n.type] = (counts[n.type] || 0) + 1;
  return { files, topology, counts, proposals, themeName: theme };
}

/** Write the repo under `dir` (made if missing) */
export function writeBig(dir, opts = {}) {
  const made = opts.from ? makeFrom(opts.from, opts) : makeBig(opts);
  for (const [rel, text] of Object.entries(made.files)) {
    const file = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return made;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const out = flag('out');
  if (!out) {
    console.error('Usage: node test/fixtures/big/make.js --out <dir> [--from <topology dir>] [--seed 245] [--theme retro]');
    process.exit(1);
  }
  const made = writeBig(path.resolve(out), { seed: flag('seed') ? Number(flag('seed')) : SEED, theme: flag('theme') || null, from: flag('from') ? path.resolve(flag('from')) : null });
  console.log(`Wrote ${made.topology.nodes.length} nodes, ${made.topology.edges.length} edges and ${made.proposals.length} proposals to ${path.resolve(out)}`);
}
