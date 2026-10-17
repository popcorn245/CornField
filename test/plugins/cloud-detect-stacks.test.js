import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { imageRef, dockerfileSources, installsIn, caddyEvidence, runnerLabels, workflowSources as sources, httpsHosts } from '../../plugins/cloud/sources.js';

const workflowSources = (text, opts) => sources(text, { yaml, ...opts });



describe('imageRef: an image reference → its registry and its name, never its tag', () => {
  it('puts an image with no registry on Docker Hub, as docker.io/', () => {
    expect(imageRef('node:22-alpine')).toEqual({ registry: 'docker.io/', name: 'node' });
    expect(imageRef('cloudflare/cloudflared:2026.9.3')).toEqual({ registry: 'docker.io/', name: 'cloudflare/cloudflared' });
    expect(imageRef('ollama/ollama')).toEqual({ registry: 'docker.io/', name: 'ollama/ollama' });
    expect(imageRef('docker.io/valkey/valkey:9@sha256:4963247afc4cd33c7d3b2d2816b9f7f8eeebab148d29056c2ca4d7cbc966f2d9')).toEqual({ registry: 'docker.io/', name: 'valkey/valkey' });
    expect(imageRef('docker.io/library/redis')).toEqual({ registry: 'docker.io/', name: 'redis' });
  });

  it('keeps an explicit registry, and drops a tag that interpolates a variable', () => {
    expect(imageRef('ghcr.io/acme/photos-server:${PHOTOS_VERSION:-release}')).toEqual({ registry: 'ghcr.io/', name: 'ghcr.io/acme/photos-server' });
    expect(imageRef('lscr.io/linuxserver/readarr:amd64-0.4.19-nightly')).toEqual({ registry: 'lscr.io/', name: 'lscr.io/linuxserver/readarr' });
    expect(imageRef('code.forgejo.org/forgejo/runner:12')).toEqual({ registry: 'code.forgejo.org/', name: 'code.forgejo.org/forgejo/runner' });
    expect(imageRef('localhost:5000/thing:1')).toEqual({ registry: 'localhost:5000/', name: 'localhost:5000/thing' });
  });

  it('resolves a registry from a variable with a default, and gives up on one without', () => {
    expect(imageRef('${REG:-ghcr.io}/a/b:1')).toEqual({ registry: 'ghcr.io/', name: 'ghcr.io/a/b' });
    expect(imageRef('${REG}/a/b:1')).toBeNull();
    expect(imageRef('')).toBeNull();
  });
});

describe('dockerfileSources: what an image build pulls', () => {
  it('reads each FROM, skipping a build stage named earlier and scratch, and the installs of every RUN', () => {
    const text = [
      '# a comment: FROM nothing',
      'FROM --platform=linux/amd64 node:22-alpine AS build',
      'RUN apk add --no-cache git \\',
      '    && npm ci',
      'FROM build AS test',
      'FROM python:3.12-slim',
      'RUN pip install --no-cache-dir "icalendar>=6,<7"',
      'FROM scratch'
    ].join('\n');
    expect(dockerfileSources(text)).toEqual({
      froms: ['node:22-alpine', 'python:3.12-slim'],
      installs: [{ packages: 'apk', words: 'apk add' }, { packages: 'npm', words: 'npm ci' }, { packages: 'pypi', words: 'pip install' }]
    });
  });

  it('names an apt-get install as apt, which the registry must then describe', () => {
    expect(installsIn('apt-get update && apt-get install -y curl')).toEqual([{ packages: 'apt', words: 'apt-get install' }]);
    expect(installsIn('npm install --omit=dev; npm ci')).toEqual([{ packages: 'npm', words: 'npm install' }, { packages: 'npm', words: 'npm ci' }]);
    expect(installsIn('python -m pip install x')).toEqual([{ packages: 'pypi', words: 'pip install' }]);
    expect(installsIn('echo npm is great')).toEqual([]);
  });
});

describe('caddyEvidence: the Caddyfile', () => {
  const site = (host        , tls        ) => `${host} {\n    reverse_proxy app:80\n${tls}}\n`;
  const dns = '    tls {\n        dns cloudflare {env.CF_API_TOKEN}\n        resolvers 1.1.1.1 1.0.0.1\n    }\n';

  it('counts DNS-01 sites by provider, their resolvers, and ACME for every site with automatic HTTPS', () => {
    const text = [
      '# dns fake {env.X}',
      '{\n    log {\n        output stdout\n    }\n}',
      site('a.example.com', dns),
      site('b.example.com, c.example.com', dns),
      site('d.example.com', ''),
      site('e.example.com', '    tls internal\n'),
      site('f.example.com', '    tls /data/f.crt /data/f.key\n'),
      site('http://g.example.com', ''),
      site(':8080', '')
    ].join('\n');
    expect(caddyEvidence(text)).toEqual([
      { match: { kind: 'caddy', value: 'dns cloudflare' }, label: 'DNS-01 challenges for 3 sites' },
      { match: { kind: 'host', value: '1.1.1.1' }, label: 'public resolvers for the DNS-01 check' },
      { match: { kind: 'host', value: '1.0.0.1' }, label: 'public resolvers for the DNS-01 check' },
      { match: { kind: 'caddy', value: 'acme' }, label: 'ACME certificates for 4 https sites' }
    ]);
  });

  it('names a global acme_ca by its host instead of the default CA', () => {
    const text = `{\n    acme_ca https://acme.example.org/directory\n}\n${site('a.example.com', '')}`;
    expect(caddyEvidence(text)).toEqual([{ match: { kind: 'host', value: 'acme.example.org' }, label: 'ACME certificates for 1 https site' }]);
    expect(caddyEvidence(`{\n    local_certs\n}\n${site('a.example.com', '')}`)).toEqual([]);
  });
});

describe('the workflows: the runner\'s labels, actions, job images, installs and downloads', () => {
  it('reads the label map the runner registers with', () => {
    expect(runnerLabels('forgejo-runner register --labels "ubuntu-latest:docker://node:20-bookworm,ubuntu-22.04:docker://node:22-bookworm,native:host"')).toEqual(
      new Map([['ubuntu-latest', 'node:20-bookworm'], ['ubuntu-22.04', 'node:22-bookworm'], ['native', null]])
    );
  });

  const labels = new Map([['ubuntu-22.04', 'node:22-bookworm'], ['native', null]]);
  const workflow = [
    'on: push',
    'env:',
    '  TOOLS: docker:cli',
    'jobs:',
    '  check:',
    '    runs-on: ubuntu-22.04',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/cache/restore@v4',
    '      - uses: https://github.com/some/action@v1',
    '      - uses: ./local/action',
    '      - run: |',
    '          # https://example.org/in-a-comment',
    '          base="https://github.com/gitleaks/gitleaks/releases/download/v8"',
    '          curl -fsSL -o x "${base}/x.tgz"',
    '          curl -fsSL "${SERVER_URL}/api/v1/raw" https://forge.example.test/x',
    '          npm ci',
    '  deploy:',
    '    runs-on: native',
    '    container: alpine:3.20',
    '    steps:',
    '      - run: |',
    '          docker run --rm \\',
    '            --network devops -v /a:/a -e A="$A" \\',
    '            "$TOOLS" sh -c \'apk add --no-cache git\'',
    '          docker run --rm --entrypoint sh curlimages/curl:8.11.1 -c true'
  ].join('\n');

  it('turns one workflow into actions, registries, packages and download hosts, with no version', () => {
    const got = workflowSources(workflow, { labels, file: '.forgejo/workflows/ci.yml', ownHost: (h        ) => h.endsWith('example.test') });
    expect(got).toEqual([
      { match: { kind: 'registry', value: 'docker.io/' }, label: 'CI jobs run in node' },
      { match: { kind: 'actions', value: 'actions/checkout' }, label: 'uses actions/checkout' },
      { match: { kind: 'actions', value: 'actions/cache' }, label: 'uses actions/cache' },
      { match: { kind: 'host', value: 'github.com' }, label: 'ci.yml: uses an action from github.com' },
      { match: { kind: 'host', value: 'github.com' }, label: 'ci.yml: downloads from github.com' },
      { match: { kind: 'packages', value: 'npm' }, label: 'ci.yml: npm ci' },
      { match: { kind: 'registry', value: 'docker.io/' }, label: 'CI jobs run in alpine' },
      { match: { kind: 'registry', value: 'docker.io/' }, label: 'ci.yml: docker run docker' },
      { match: { kind: 'packages', value: 'apk' }, label: 'ci.yml: apk add' },
      { match: { kind: 'registry', value: 'docker.io/' }, label: 'ci.yml: docker run curlimages/curl' }
    ]);
    expect(JSON.stringify(got)).not.toMatch(/@v4|8\.11|20-bookworm|22-bookworm|3\.20/);
  });

  it('refuses a job on a label the runner does not have', () => {
    expect(() => workflowSources('jobs:\n  x:\n    runs-on: windows-latest\n    steps: []\n', { labels, file: 'w.yml' })).toThrow(/windows-latest/);
  });

  it('httpsHosts finds bare hosts in https URLs, never a variable or a path', () => {
    expect(httpsHosts('curl https://a.example.com/x/y?z "https://${HOST}/p" http://plain.example.com https://b.example.com:8443/q')).toEqual(['a.example.com', 'b.example.com']);
  });
});
