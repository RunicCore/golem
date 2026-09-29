import { routeFor, routes } from './routes.js';
export const JOINED = routeFor('list');
export const RESOURCE = routes.resource({ service: 'payments', resource: 'transactions' });
