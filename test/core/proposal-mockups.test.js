import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { validateProposal, mockupPathProblem, mockupsOf, applyEdits, MAX_MOCKUPS } from '../../core/proposal.js';
import { SAMPLE } from '../helpers.js';

const topology = {
  nodes: [{ id: 'root', label: 'root', type: 'root' }, { id: 'app-a', label: 'a', type: 'app' }, { id: 'page-old', label: '/old', type: 'page' }],
  edges: [{ from: 'root', to: 'app-a' }, { from: 'app-a', to: 'page-old' }],
};
const proposal = (mockups) => ({
  version: 1,
  title: 'Meals',
  summary: 'Adds /meals.',
  nodes: { add: [{ id: 'page-meals', label: '/meals', type: 'page', parent: 'app-a' }], change: [{ id: 'page-old', set: { desc: 'x' }, why: 'w' }], remove: [] },
  ...(mockups === undefined ? {} : { mockups }),
});
const problems = (mockups) => validateProposal(topology, proposal(mockups)).map((e) => `${e.path}: ${e.message}`);
const ok = { node: 'page-meals', path: '0013-meals/list.png', title: 'The meal list' };

describe('mockups in a proposal', () => {
  it('are optional: a proposal without them is valid as it always was', () => {
    expect(problems(undefined)).toEqual([]);
    expect(problems([])).toEqual([]);
  });

  it('accept a node the proposal adds, one it changes and one it removes, in every allowed type', () => {
    const p = proposal();
    p.nodes.remove = [{ id: 'root', why: 'gone' }];
    p.mockups = ['png', 'jpg', 'jpeg', 'webp', 'svg', 'html', 'PNG'].map((ext, i) => ({ node: ['page-meals', 'page-old', 'root'][i % 3], path: `a/b/screen-${i}.${ext}`, title: `Screen ${i}` }));
    expect(validateProposal(topology, p)).toEqual([]);
  });

  it('must be a list of { node, path, title } and nothing else', () => {
    expect(problems({})).toEqual(['mockups: "mockups" must be a list.']);
    expect(problems(['x'])).toEqual(['mockups[0]: A mockup is an object with a node, a path and a title.']);
    expect(problems([{ ...ok, extra: 1 }])[0]).toMatch(/^mockups\[0\]\.extra: Unknown key "extra"/);
    expect(problems([{ ...ok, title: ' ' }])[0]).toMatch(/^mockups\[0\]\.title: A mockup needs a "title"/);
    expect(problems([{ path: ok.path, title: 'x' }])[0]).toMatch(/^mockups\[0\]\.node: A mockup needs the "node"/);
    expect(problems(Array.from({ length: MAX_MOCKUPS + 1 }, (_, i) => ({ ...ok, path: `s${i}.png` })))[0]).toMatch(/At most 40 mockups/);
  });

  it('must name a node the proposal touches', () => {
    expect(problems([{ ...ok, node: 'app-a' }])).toEqual(['mockups[0].node: Mockup is beside node "app-a", which this proposal does not add, change or remove. Name a node the proposal touches.']);
    expect(problems([{ ...ok, node: 'nope' }])).toHaveLength(1);
  });

  it('keep their path inside the proposals folder', () => {
    for (const bad of ['../secret.png', 'a/../../b.png', '/etc/passwd.png', '/abs.png', 'a/./b.png', 'a//b.png', 'C:/x.png', 'c:\\x.png', 'a\\b.png', '.hidden/x.png', 'a/.x.png', '', '   ', 'a/b/', 'a%2e%2e/b.png', 'a?b.png', 'a#b.png', 'a\u0000.png', 'x'.repeat(201) + '.png']) {
      expect(mockupPathProblem(bad), JSON.stringify(bad)).toEqual(expect.any(String));
      expect(problems([{ ...ok, path: bad }]), JSON.stringify(bad)).not.toEqual([]);
    }
    expect(mockupPathProblem(7)).toEqual(expect.any(String));
    expect(mockupPathProblem('0013-meals/list.png')).toBeNull();
  });

  it('are one of png, jpg, webp, svg, html', () => {
    for (const bad of ['x.gif', 'x.js', 'x.json', 'x.exe', 'x', 'x.', 'x.png.js', 'x.html.txt', 'png']) expect(mockupPathProblem(bad), bad).toMatch(/is one of: png, jpg, jpeg, webp, svg, html/);
    expect(problems([{ ...ok, path: 'x.js' }])[0]).toMatch(/^mockups\[0\]\.path: /);
  });

  it('are not listed twice for one node', () => {
    expect(problems([ok, ok])).toEqual(['mockups[1]: Mockup "0013-meals/list.png" is listed twice for node "page-meals".']);
  });

  it('mockupsOf gives the ones that can be served, by their position', () => {
    const p = proposal([{ node: 'x', path: '../bad.png', title: 'Bad' }, ok, 'junk', { ...ok, path: 'b.svg', title: ' Second ' }]);
    expect(mockupsOf(p)).toEqual([{ index: 1, ...ok }, { index: 3, node: 'page-meals', path: 'b.svg', title: 'Second' }]);
    expect(mockupsOf(null)).toEqual([]);
    expect(mockupsOf({ mockups: 'x' })).toEqual([]);
  });

  it('go with a node a what-if edit drops, and are otherwise kept', () => {
    const p = proposal([ok, { node: 'page-old', path: 'old.png', title: 'Old' }]);
    expect(applyEdits(p, [{ op: 'remove-node', id: 'page-meals' }]).mockups).toEqual([{ node: 'page-old', path: 'old.png', title: 'Old' }]);
    expect(applyEdits(p, []).mockups).toEqual(p.mockups);
    expect(p.mockups).toHaveLength(2);
  });

  it('are in the sample proposal, and its files are there', () => {
    const dir = path.join(SAMPLE, 'docs/specs/proposals');
    const sample = JSON.parse(fs.readFileSync(path.join(dir, '0002-checkout.json'), 'utf8'));
    const list = mockupsOf(sample);
    expect(list.map((m) => path.extname(m.path))).toEqual(['.svg', '.html', '.png']);
    for (const m of list) expect(fs.statSync(path.join(dir, m.path)).isFile(), m.path).toBe(true);
  });
});

describe('validate and the mockup files', () => {
  it('fails a proposal whose mockup is not a file beside it, and passes the sample, whose files are there', async () => {
    const os = await import('node:os');
    const { validateProposalFiles } = await import('../../core/validate.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-mockups-'));
    try {
      fs.mkdirSync(path.join(dir, '0013-meals'));
      fs.writeFileSync(path.join(dir, '0013-meals', 'list.png'), 'png');
      fs.mkdirSync(path.join(dir, '0013-meals', 'folder.png'));
      fs.writeFileSync(path.join(dir, '0013-meals.json'), JSON.stringify(proposal([ok, { ...ok, path: '0013-meals/typo.png' }, { ...ok, path: '0013-meals/folder.png' }])));
      expect(validateProposalFiles(topology, dir, path.dirname(dir)).filter((p) => p.includes('mockups'))).toEqual([
        `${path.basename(dir)}/0013-meals.json: mockups[1].path: "0013-meals/typo.png" is not a file in ${path.basename(dir)}.`,
        `${path.basename(dir)}/0013-meals.json: mockups[2].path: "0013-meals/folder.png" is not a file in ${path.basename(dir)}.`,
      ]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    const sample = JSON.parse(fs.readFileSync(path.join(SAMPLE, 'topology.json'), 'utf8'));
    expect(validateProposalFiles(sample, path.join(SAMPLE, 'docs/specs/proposals'), SAMPLE).filter((p) => p.includes('mockups'))).toEqual([]);
  });
});
