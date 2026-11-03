import type { Visit } from './types.js';

declare const visit: Visit;
const plainOrDates: string | Date[] | null = visit.plainOrDates;
const plainOrLeg: string | [] | [Date] | null = visit.plainOrLeg;

void plainOrDates; void plainOrLeg;
