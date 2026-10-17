/** The sample repo's config: the built-in derivers, its own personas roles, the house file */
export default {
  title: 'Acme home',
  derivers: [
    'starter',
    'personas',
    { use: 'cloud', options: { ownDomains: ['example.test'], code: ['packages'], caddyfiles: [{ file: 'stacks/app-stack/Caddyfile', from: 'container-caddy' }] } },
  ],
  personas: { roles: ['admin', 'adult', 'child'] },
  sources: { house: { use: 'house', options: { file: 'cornfield.house.json' } } },
  forge: { type: 'forgejo', url: 'https://forge.example.test', repo: 'acme/home' },
  worktrees: '.worktrees',
};
