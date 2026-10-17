import { describe, it, expect } from 'vitest';
import { isOutsideHost as outside, hostsIn as hostsOf } from '../../plugins/cloud/hosts.js';

/** The sample's own domains: never outside */
const OWN = ['example.test', 'tailnet.example'];
const isOutsideHost = (h) => outside(h, OWN);
const hostsIn = (source, type) => hostsOf(source, type, { ownDomains: OWN });

const H = 'https://';

describe('isOutsideHost: what is not ours', () => {
  it('keeps a public name and drops our own domains, reserved names and private addresses', () => {
    expect(isOutsideHost('world.openfoodfacts.org')).toBe(true);
    expect(isOutsideHost('1.1.1.1')).toBe(true);
    for (const h of ['example.test', 'tasks.example.test', 'server-1.tailnet.example', 'example.com', 'images.example.com', 'api.test', 'x.invalid', 'a.example', 'app.localhost', 'printer.local', '127.0.0.1', '10.0.0.4', '192.168.0.10', '172.20.0.1', '100.64.0.7'])
      expect(isOutsideHost(h), h).toBe(false);
  });
});

describe('hostsIn: each https host in a file, and what the code does with it', () => {
  it('reads a plain string in server code as a call, and a markdown link or a template anchor as a link', () => {
    const src = `const API = '${H}api.tailscale.com/api/v2';\nconst body = \`see [docs](${H}claude.com/claude-code)\`;\nconst a = \`<a href="${H}www.wikipedia.org/wiki/\${id}" target="_blank">x</a>\`;`;
    expect(hostsIn(src, 'code')).toEqual([
      { host: 'api.tailscale.com', context: 'server' },
      { host: 'claude.com', context: 'link' },
      { host: 'www.wikipedia.org', context: 'link' }
    ]);
  });

  it('reads a stylesheet or preconnect <link>, an <iframe>, an <img>, an import map and a CSS @import as browser fetches', () => {
    const html = `<link rel="preconnect" href="${H}fonts.gstatic.com" crossorigin>
<link href="${H}fonts.googleapis.com/css2?family=X&display=swap" rel="stylesheet">
<link rel="canonical" href="${H}elsewhere.org/page">
<script type="importmap">{ "imports": { "phaser": "${H}cdn.jsdelivr.net/npm/phaser@4/x.js" } }</script>
<iframe width="1" src="${H}www.youtube-nocookie.com/embed/x"></iframe><img src="${H}i.ytimg.com/vi/x.jpg" alt="">
<pop-avatar src="${H}images.unsplash.com/p"></pop-avatar>
<style>@import url("${H}fonts.googleapis.com/css2");</style>
<meta property="og:image" content="${H}www.notion.so/cover.jpg" />
<a href="${H}discord.com/invite">Discord</a> <pop-icon-link href="${H}twitch.tv/x"></pop-icon-link>
<p>Text naming ${H}getsharex.com in prose.</p>`;
    expect(hostsIn(html, 'html')).toEqual([
      { host: 'fonts.gstatic.com', context: 'browser', how: 'link tag' },
      { host: 'fonts.googleapis.com', context: 'browser', how: 'link tag' },
      { host: 'elsewhere.org', context: 'link' },
      { host: 'cdn.jsdelivr.net', context: 'browser', how: 'import map' },
      { host: 'www.youtube-nocookie.com', context: 'browser', how: 'iframe' },
      { host: 'i.ytimg.com', context: 'browser', how: 'img' },
      { host: 'images.unsplash.com', context: 'browser', how: 'pop-avatar' },
      { host: 'fonts.googleapis.com', context: 'browser', how: 'CSS @import' },
      { host: 'www.notion.so', context: 'link' },
      { host: 'discord.com', context: 'link' },
      { host: 'twitch.tv', context: 'link' },
      { host: 'getsharex.com', context: 'link' }
    ]);
  });

  it('reads a page shell in server code like a page, and ignores comments, http, our own hosts and reserved ones', () => {
    const src = `// ${H}commented.org is prose\n/* ${H}also-commented.org */\nconst head = \`<link rel="stylesheet" href="${H}fonts.googleapis.com/css2">\`;\nconst x = 'http://plain.org'; const y = '${H}tasks.example.test/x'; const z = '${H}api.example.test';`;
    expect(hostsIn(src, 'code')).toEqual([{ host: 'fonts.googleapis.com', context: 'browser', how: 'link tag' }]);
  });

  it('reads a CSS file: @import and url() fetch, the rest of the file is not a call', () => {
    expect(hostsIn(`/* ${H}in-a-comment.org */\n@import url("${H}fonts.googleapis.com/css2");\n.x { background: url(${H}cdn.other-site.org/bg.png); }`, 'css')).toEqual([
      { host: 'fonts.googleapis.com', context: 'browser', how: 'CSS @import' },
      { host: 'cdn.other-site.org', context: 'browser', how: 'CSS url()' }
    ]);
  });

  it('reads a URL in a constant by where the code puts it', () => {
    const src = `const FONTS_URL = '${H}fonts.googleapis.com/css2?family=X';\nconst MAP = '${H}maps.other-site.org';\nconst API = '${H}api.other-site.org';\nconst head = \`<link rel="stylesheet" href="\${FONTS_URL}"><a href="\${MAP}">map</a>\`;\nfetch(API);`;
    expect(hostsIn(src, 'code')).toEqual([
      { host: 'fonts.googleapis.com', context: 'browser', how: 'link tag' },
      { host: 'maps.other-site.org', context: 'link' },
      { host: 'api.other-site.org', context: 'server' }
    ]);
  });

  it('never mistakes a comparison in code for a tag', () => {
    expect(hostsIn(`if (a <b) { const url = '${H}api.other-site.org/x'; }`, 'code')).toEqual([{ host: 'api.other-site.org', context: 'server' }]);
  });
});
