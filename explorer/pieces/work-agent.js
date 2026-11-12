/**
 * @module explorer/pieces/work-agent
 *
 * The Start an agent dialog (a modal dialog over a scrim). Part of the Work piece (pieces/work.js): `install(ctx)` makes this part's functions for one mount, and hands the ones other parts call
 * to `ctx.fn`; nothing is shared between two mounts.
 */

import { RUNS_URL, canRetry, retryRefs, retryWords, limitsFromFields, defaultLimits, LIMIT_KEYS, briefUrl, KINDS, aboutWords, startBody, startWords, confirmStartWords } from '../runs-model.js';
import { trapTab } from '../focusables.js';
import { option } from './work-common.js';

export function install(ctx) {
  const { ui, m, fn, root, $, scope } = ctx;
  const { announce, t } = ctx.h;

  const agentEl = () => $('agent-start');

  /** While the dialog is open the focus cannot leave it */
  function keepFocusInAgent(e) {
    const el = agentEl();
    if (ui.agent && el && !el.contains(e.target)) $('agent-kind').focus();
  }

  /**
   * Opens the Start an agent dialog for `issue:<n>` or `proposal:<slug>`; the focus goes to the first field. The limit fields hold what the request
   * starts from (the config's, for the profile). With `again` (a run that failed or was stopped) it is **Start again**: the same kind, refs,
   * profile, brief and limits filled in, all editable, and the request will carry `retryOf`. `brief` is that run's whole brief when the list's was cut
   */
  async function openAgent(ref, opener, again = null, brief = null) {
    if (!agentEl() || ui.agent || ui.confirm) return; // one dialog at a time
    const at = ref.indexOf(':');
    const type = ref.slice(0, at);
    const value = ref.slice(at + 1);
    const refs = again ? retryRefs(again) : type === 'proposal' ? { proposal: value } : { issue: Number(value) };
    ui.agent = { opener, refs, posting: false, retryOf: again ? again.runId : null };
    // The profiles the config lists come with the runs: asked for if the Agents tab has not been opened yet
    if (!ui.runs) { await fn.loadRuns(false); if (ui.kind === 'work') fn.paint(); }
    if (!ui.agent) return;
    const profiles = (ui.runs && ui.runs.data && ui.runs.data.profiles) || [];
    $('agent-start-about').textContent = `About ${aboutWords(refs)}`;
    fn.paintRunner('agent-start-runner', ui.runs && ui.runs.data);
    const kind = again ? again.kind : 'code';
    // The old run's profile stays on offer even if the config no longer lists it: the server then says so, in its words
    const shown = again && again.profile && !profiles.includes(again.profile) ? [...profiles, again.profile] : profiles;
    $('agent-kind').innerHTML = KINDS.map(([v, l]) => option(v, l, v === kind)).join('');
    $('agent-profile').innerHTML = option('', 'No profile', !(again && again.profile)) + shown.map((p) => option(p, p, !!again && p === again.profile)).join('');
    $('agent-profile-field').hidden = !shown.length;
    $('agent-profile').value = again && again.profile ? again.profile : ''; // as well as `selected`, which not every DOM honours
    $('agent-start-title').textContent = again ? t('startAgain') : t('startAgent');
    const note = $('agent-retry-note');
    note.hidden = !again;
    note.textContent = again ? retryWords(again) : '';
    fillLimits(again ? again.limits || {} : limitDefaultsNow());
    $('agent-brief').value = brief ?? (again && typeof again.brief === 'string' ? again.brief : '');
    $('agent-force').checked = false;
    $('agent-force-field').hidden = true;
    $('agent-start-msg').hidden = true;
    $('agent-start-msg').textContent = '';
    $('agent-start-words').textContent = confirmStartWords(refs, fn.forgeName());
    const go = $('agent-start-go');
    go.disabled = false;
    go.removeAttribute('aria-busy');
    go.textContent = fn.askRunnerWords();
    m.agentTrap = scope.listen(root, 'focusin', keepFocusInAgent);
    agentEl().hidden = false;
    $('agent-kind').focus();
    announce(`${again ? t('startAgain') : t('startAgent')} on ${aboutWords(refs)}. ${confirmStartWords(refs, fn.forgeName())}`);
  }

  /** "Start again" on a run that failed or was stopped. A brief the list shows cut is read whole first: the dialog never starts from part of one */
  async function startAgain(runId) {
    const run = ui.runs && ui.runs.data ? ui.runs.data.runs.find((r) => r.runId === runId) : null;
    if (!run || !canRetry(run) || ui.agent || ui.retrying) return;
    let brief = null;
    if (run.briefCut) {
      ui.retrying = true;
      const res = await fn.request(briefUrl(runId), false);
      ui.retrying = false;
      if (!res.ok || typeof res.body.brief !== 'string') {
        ui.runNote = { text: `The brief of ${runId} could not be read, so Start again did not open: ${fn.failWords(res)}`, ok: false };
        fn.paint();
        announce(ui.runNote.text);
        return;
      }
      brief = res.body.brief;
    }
    const about = run.refs.proposal != null ? `proposal:${run.refs.proposal}` : `issue:${run.refs.issue ?? run.refs.thread}`;
    openAgent(about, `[data-forge-retry="${runId}"]`, run, brief);
  }

  /** The limits the config gives a request under the chosen profile */
  const limitDefaultsNow = () => defaultLimits(ui.runs && ui.runs.data && ui.runs.data.limits, $('agent-profile-field').hidden ? '' : $('agent-profile').value);

  /** What the four limit fields hold, as text */
  const limitFields = () => Object.fromEntries(LIMIT_KEYS.map((k) => [k, $(`agent-limit-${k}`).value]));

  /** Fills the four limit fields (blank where `limits` has none) and remembers what was filled */
  function fillLimits(limits) {
    for (const k of LIMIT_KEYS) {
      const field = $(`agent-limit-${k}`);
      field.value = limits && limits[k] != null ? String(limits[k]) : '';
      field.removeAttribute('aria-invalid');
      field.removeAttribute('aria-describedby');
    }
    if (ui.agent) ui.agent.filled = JSON.stringify(limitFields());
  }

  /** Another profile: its limits fill the fields, unless the person has typed in them */
  function onAgentProfile() {
    if (ui.agent && ui.agent.filled === JSON.stringify(limitFields())) fillLimits(limitDefaultsNow());
  }

  /** Closes the dialog; the focus goes back to the button that opened it unless told not to */
  function closeAgent({ restoreFocus = true } = {}) {
    const el = agentEl();
    if (!el || !ui.agent) return;
    const { opener } = ui.agent;
    ui.agent = null;
    el.hidden = true;
    if (m.agentTrap) { m.agentTrap(); m.agentTrap = null; }
    if (!restoreFocus) return;
    const back = root.querySelector(opener) || $('forge-title'); // the node panel's Start a run is an opener too
    if (back && !back.disabled) back.focus();
  }

  /** The one write: posts the choices once; a refusal stays in the dialog, in the server's words */
  async function submitAgent(e) {
    e.preventDefault();
    if (!ui.agent || ui.agent.posting) return;
    ui.agent.posting = true;
    const go = $('agent-start-go');
    go.disabled = true;
    go.setAttribute('aria-busy', 'true');
    go.textContent = 'Asking …';
    $('agent-start-msg').hidden = true;
    const again = ui.agent.retryOf;
    const fields = limitFields();
    const limits = limitsFromFields(fields);
    // Each field that is not a number above zero is marked, and the first has the focus; the message says why
    const wrong = LIMIT_KEYS.filter((k) => limitsFromFields({ [k]: fields[k] }) === null);
    for (const k of LIMIT_KEYS) {
      const field = $(`agent-limit-${k}`);
      if (wrong.includes(k)) { field.setAttribute('aria-invalid', 'true'); field.setAttribute('aria-describedby', 'agent-start-msg'); } else { field.removeAttribute('aria-invalid'); field.removeAttribute('aria-describedby'); }
    }
    if (limits === null) {
      ui.agent.posting = false;
      go.disabled = false;
      go.removeAttribute('aria-busy');
      go.textContent = fn.askRunnerWords();
      const bad = $('agent-start-msg');
      bad.textContent = `A limit is a number above zero, or blank for the config's (${wrong.join(', ')}).`;
      bad.hidden = false;
      $(`agent-limit-${wrong[0]}`).focus();
      announce(bad.textContent);
      return;
    }
    const res = await fn.post(RUNS_URL, startBody({
      kind: $('agent-kind').value, profile: $('agent-profile-field').hidden ? '' : $('agent-profile').value, brief: $('agent-brief').value, refs: ui.agent.refs, force: $('agent-force').checked,
      limits, ...(again ? { retryOf: again } : {}),
    }));
    if (!ui.agent) return;
    ui.agent.posting = false;
    const text = startWords(res.status, res.body);
    if (res.ok) {
      closeAgent();
      ui.runNote = { text, ok: true };
      announce(text);
      await fn.loadRuns(false);
      fn.paint();
      return;
    }
    go.disabled = false;
    go.removeAttribute('aria-busy');
    go.textContent = fn.askRunnerWords();
    const msg = $('agent-start-msg');
    msg.textContent = text;
    msg.hidden = false;
    // The one-per-issue rule can be set aside on purpose; the cap cannot
    if (res.body && res.body.code === 'run-open') $('agent-force-field').hidden = false;
    announce(text);
  }

  /** Keys inside the dialog: Escape cancels, Tab stays inside, nothing reaches the map behind it */
  function onAgentKey(e) {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!ui.agent || !ui.agent.posting) closeAgent();
      return;
    }
    trapTab(e, agentEl());
  }

  function onAgentClick(e) {
    const t = e.target;
    if (t === agentEl()) { if (ui.agent && !ui.agent.posting) closeAgent(); return; } // the scrim
    if (t.closest && t.closest('[data-action="agent-start-cancel"]') && ui.agent && !ui.agent.posting) closeAgent();
  }

  /** `?proposal=<slug>&start=1`: the Start dialog on that proposal (the proposal itself is opened by proposal.js) */
  async function openProposalStart(slug, opener = '#forge-title') {
    if (!ui.config || !agentEl()) return false;
    await openAgent(`proposal:${slug}`, opener);
    return !!ui.agent;
  }

  /** Whether the Start dialog can open now: the server runs agents and the page has the dialog (the node panel's "Start a run" asks) */
  const canStartAgent = () => !!(ui.config && ui.config.agents && agentEl());

  Object.assign(fn, { agentEl, keepFocusInAgent, openAgent, startAgain, limitDefaultsNow, limitFields, fillLimits, onAgentProfile, closeAgent, submitAgent, onAgentKey, onAgentClick, openProposalStart, canStartAgent });
}
