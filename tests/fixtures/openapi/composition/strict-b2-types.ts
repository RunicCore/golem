import type { Visit } from './index.js';

declare const visit: Visit;
const b: undefined = visit.m.b;

void b;
