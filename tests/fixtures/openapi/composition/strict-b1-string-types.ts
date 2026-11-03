import type { Visit } from './index.js';

declare const visit: Visit;
const n: string | undefined = visit.m.n;

void n;
