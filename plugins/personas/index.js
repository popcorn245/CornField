/**
 * @module plugins/personas
 *
 * The personas deriver: the repo's `topology.personas.json` (core/personas.js has the format) as one
 * `store-personas` node and a `persona-<id>` node per archetype. A persona is a role and the groups
 * it sits in, never a real person. The roles a persona may have come from the config
 * (`personas.roles`); with none set, any role in kebab case is accepted. A repo with no personas file
 * gets nothing from this deriver.
 */

import { derivePersonas, PERSONA_STORE_ID } from '../../core/personas.js';

export default {
  name: 'personas',
  contract: 1,
  owns: ['persona'],
  derive(ctx) {
    const { roles = null, parent = 'root' } = ctx.config?.personas || {};
    const out = derivePersonas({ read: ctx.read, exists: ctx.exists, roles, parent });
    return { ...out, ownedIds: out.nodes.length ? [PERSONA_STORE_ID] : [] };
  },
};
