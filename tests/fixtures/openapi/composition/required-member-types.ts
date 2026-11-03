import type { Visit } from './index.js';

declare const visit: Visit;
const at: Date = visit.m.at;

void at;
