import type { Visit } from './index.js';

declare const visit: Visit;
const at: Date | undefined = visit.m.at;

void at;
