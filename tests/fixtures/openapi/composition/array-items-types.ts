import type { Visit } from './index.js';

declare const visit: Visit;
const first: { a?: Date } & { b?: Date } | undefined = visit.e[0];

void first;
