import type { Visit } from './index.js';

declare const visit: Visit;
const x: Date | undefined = visit.m.x;
const b: Date | undefined = visit.m.b;

void x; void b;
