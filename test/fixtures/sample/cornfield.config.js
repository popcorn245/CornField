/** The sample repo's config: the built-in derivers (compose included), its own personas roles, the house file */
export default {
  title: 'Acme home',
  derivers: [
    'starter',
    'personas',
    // The stack and its containers from stacks/app-stack/compose.yml, the apps from its Caddyfile
    'compose',
    { use: 'cloud', options: { ownDomains: ['example.test'], code: ['packages'], caddyfiles: [{ file: 'stacks/app-stack/Caddyfile', from: 'container-caddy' }] } },
  ],
  personas: { roles: ['admin', 'adult', 'child'] },
  sources: { house: { use: 'house', options: { file: 'cornfield.house.json' } } },
  forge: { type: 'forgejo', url: 'https://forge.example.test', repo: 'acme/home' },
  worktrees: '.worktrees',
};
