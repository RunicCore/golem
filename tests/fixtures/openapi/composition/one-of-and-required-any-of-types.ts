import type { Visit } from './index.js';

declare const visit: Visit;
const variant: string = visit.m.kind === 'a' ? visit.m.a : visit.m.b;
const email: string | undefined = visit.m.email;
const phone: string | undefined = visit.m.phone;

void variant;
void email;
void phone;
