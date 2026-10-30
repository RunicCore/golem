import type { Visit } from './types.js';

declare const visit: Visit;
const window: { at?: Date } | null = visit.window;

void window;
