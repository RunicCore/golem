import type { Visit } from './types.js';

declare const visit: Visit;
const at: Date | undefined = visit.based.at;

void at;
