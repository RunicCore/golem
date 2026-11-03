import type { Visit } from './index.js';

// The component is the union of merged objects, and the field carries the converted type.
declare const visit: Visit;
const id: string = visit.m.id;
const at: Date | undefined = visit.m.at;
const variant: Date | string = visit.m.kind === 'a' ? visit.m.a : visit.m.b;

void id;
void at;
void variant;
