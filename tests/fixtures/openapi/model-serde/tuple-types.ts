import type { Itinerary } from './types.js';

declare const itinerary: Itinerary;
const stops: [] | [string] | [string, ...Date[]] = itinerary.stops;
const leg: [] | [string] | [string, Date] = itinerary.leg;
const held: [] | [Date] = itinerary.held;

void stops; void leg; void held;
