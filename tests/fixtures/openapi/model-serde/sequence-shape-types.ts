import type { Visit } from './types.js';

declare const visit: Visit;
const maybeVisits: Date[] | null = visit.maybeVisits;
const untypedVisits: Date[] = visit.untypedVisits;
const maybeLeg: [] | [string] | [string, Date] | null = visit.maybeLeg;
const untypedLeg: [] | [string] | [string, Date] = visit.untypedLeg;

void maybeVisits; void untypedVisits; void maybeLeg; void untypedLeg;
