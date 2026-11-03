import type { Visit } from './index.js';

declare const visit: Visit;
const x: undefined = visit.m.x;

void x;
