import type { Visit } from './types.js';

declare const visit: Visit;
const at: Date | undefined = visit.merged.at;
const b: Date | undefined = visit.merged.b;

void at; void b;
