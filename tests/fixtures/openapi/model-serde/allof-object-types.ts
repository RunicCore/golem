import type { Visit } from './types.js';

declare const visit: Visit;
const window: { at?: Date } = visit.window;

void window;
