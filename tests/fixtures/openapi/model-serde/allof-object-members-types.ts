import type { Visit } from './types.js';

declare const visit: Visit;
const at: Date | undefined = visit.members.at;
const b: Date | undefined = visit.members.b;

void at; void b;
