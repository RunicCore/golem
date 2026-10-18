import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { ItineraryModel } from './index.js';

const itinerary = decodeGeneratedModel(ItineraryModel, {
  stops: ['label', '2024-05-06T07:08:09.000Z'],
  leg: ['gate', '2024-05-07T08:09:10.000Z'],
});
const stops: [] | [string] | [string, ...Date[]] = itinerary.stops;
const leg: [] | [string] | [string, Date] = itinerary.leg;

void stops; void leg;
