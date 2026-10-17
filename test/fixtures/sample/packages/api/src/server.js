/** The API: orders and the address search */
import { money } from '@acme/shared';
import { search } from './geo.js';

export const routes = { '/api/v1/orders': () => money(0), '/api/v1/geo/search': search };
