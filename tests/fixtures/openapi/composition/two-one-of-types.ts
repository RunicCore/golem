import type { Visit } from './index.js';

declare const visit: Visit;
const variant: string = visit.m.kind === 'a' ? visit.m.a : visit.m.b;
const mode: string = visit.m.mode === 'x' ? visit.m.x : visit.m.y;

void variant;
void mode;
