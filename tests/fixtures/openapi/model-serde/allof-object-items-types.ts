import type { Visit } from './types.js';

declare const visit: Visit;
const a: Date | undefined = visit.entries[0]?.a;
const b: Date | undefined = visit.entries[0]?.b;

void a; void b;
