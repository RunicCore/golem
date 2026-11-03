import type { Visit } from './types.js';

declare const visit: Visit;
const at: Date = visit.window.at;

void at;
