import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { validateProposal, MAX_LINKS, MAX_LINK_LABEL } from '../../core/proposal.js';
import { isLinkHref, linkProblems, usableLinks } from '../../core/schema.js';
import { SAMPLE } from '../helpers.js';

const topology = {
  nodes: [{ id: 'root', label: 'root', type: 'root' }, { id: 'app-a', label: 'a', type: 'app' }],
  edges: [{ from: 'root', to: 'app-a' }],
};
const proposal = (links) => ({
  version: 1,
  title: 'Meals',
  summary: 'Adds /meals.',
  nodes: { add: [{ id: 'page-meals', label: '/meals', type: 'page', parent: 'app-a' }] },
  ...(links === undefined ? {} : { links }),
});
const problems = (links) => validateProposal(topology, proposal(links)).map((e) => `${e.path}: ${e.message}`);
const ok = { label: 'Walkthrough', href: 'https://example.com/book/?spec=0042' };

describe('links in a proposal', () => {
  it('are optional: a proposal without them is valid as it always was', () => {
    expect(problems(undefined)).toEqual([]);
    expect(problems([])).toEqual([]);
  });

  it('accept an https address, an http address and a path in the site', () => {
    expect(problems([ok, { label: 'Preview', href: 'http://preview.example.test/a' }, { label: 'Docs', href: '/docs/checkout' }])).toEqual([]);
  });

  it('must be a list', () => {
    expect(problems('https://example.com')).toEqual(['links: "links" must be a list of { label, href }.']);
    expect(problems({ label: 'x', href: '/x' })).toEqual(['links: "links" must be a list of { label, href }.']);
  });

  it('name the entry that is not an object', () => {
    for (const bad of ['https://example.com', null, 3, ['a']]) expect(problems([ok, bad])).toEqual([expect.stringMatching(/^links\[1\]: links\[1\] must be \{ label, href \}/)]);
  });

  it('refuse an href that is not http, https or a path in the site, naming links[i].href', () => {
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'file:///etc/passwd', 'ftp://example.com/x', '//evil.example.com/x', '/\\evil.example.com', 'docs/x', 'https://', ' https://example.com', 'https://example.com/a b', '', 'mailto:a@example.com']) {
      expect(problems([ok, { label: 'Bad', href }]), href).toEqual([expect.stringMatching(/^links\[1\]\.href: links\[1\]\.href must be an http: or https: address/)]);
    }
    expect(problems([{ label: 'No href' }])).toEqual([expect.stringMatching(/^links\[0\]\.href:/)]);
    expect(problems([{ label: 'Number', href: 5 }])).toEqual([expect.stringMatching(/^links\[0\]\.href:/)]);
  });

  it('need a label of words, and not a long one', () => {
    for (const label of ['', '   ', undefined, 3, null]) expect(problems([{ label, href: '/x' }]), String(label)).toEqual([expect.stringMatching(/^links\[0\]\.label: /)]);
    expect(problems([{ label: 'x'.repeat(MAX_LINK_LABEL), href: '/x' }])).toEqual([]);
    expect(problems([{ label: 'x'.repeat(MAX_LINK_LABEL + 1), href: '/x' }])).toEqual([`links[0].label: links[0].label is ${MAX_LINK_LABEL + 1} characters; at most ${MAX_LINK_LABEL}.`]);
  });

  it('refuse a key a link does not have', () => {
    expect(problems([{ ...ok, target: '_self' }])).toEqual(['links[0].target: Unknown key "target" in a link. A link has: label, href.']);
  });

  it('are at most 8', () => {
    const many = (n) => Array.from({ length: n }, (_, i) => ({ label: `Link ${i}`, href: `/l/${i}` }));
    expect(MAX_LINKS).toBe(8);
    expect(problems(many(8))).toEqual([]);
    expect(problems(many(9))).toEqual(['links: "links" has 9 links; at most 8.']);
  });

  it('are a key of a proposal, not an unknown one', () => {
    expect(problems([ok]).join()).not.toMatch(/Unknown key/);
    expect(validateProposal(topology, { ...proposal([ok]), link: [] }).map((e) => e.message)).toEqual([expect.stringContaining('Unknown key "link"')]);
  });

  it('are in the sample proposal, which still validates', () => {
    const dir = path.join(SAMPLE, 'docs', 'specs', 'proposals');
    const file = JSON.parse(fs.readFileSync(path.join(dir, '0002-checkout.json'), 'utf8'));
    expect(Array.isArray(file.links) && file.links.length).toBeGreaterThan(0);
    expect(linkProblems(file.links, { max: MAX_LINKS, maxLabel: MAX_LINK_LABEL, closed: true })).toEqual([]);
  });
});

describe('the one check of a link', () => {
  it('isLinkHref', () => {
    expect(['https://a.test', 'http://a.test/x?y=1#z', '/docs', '/'].map(isLinkHref)).toEqual([true, true, true, true]);
    expect(['javascript:1', '//a.test', '/\\a.test', 'x', null, 5, 'https://a.test/\n'].map(isLinkHref)).toEqual([false, false, false, false, false, false, false]);
  });

  it('usableLinks leaves out what the check refuses and keeps nothing but label and href', () => {
    const got = usableLinks([{ ...ok, onclick: 'x()' }, { label: 'Bad', href: 'javascript:alert(1)' }, null, 'x', { label: '', href: '/x' }, { label: 'Docs', href: '/docs' }]);
    expect(got).toEqual([ok, { label: 'Docs', href: '/docs' }]);
    expect(usableLinks(undefined)).toEqual([]);
    expect(usableLinks('x')).toEqual([]);
    expect(usableLinks(Array.from({ length: 12 }, () => ok), { max: 8 })).toHaveLength(8);
    expect(usableLinks([{ label: 'x'.repeat(61), href: '/x' }], { maxLabel: 60 })).toEqual([]);
  });
});
