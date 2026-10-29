import { fromWireFormat } from '@exprtlabs/golem/serde';
import { ItineraryModel } from './index.js';

const itinerary = fromWireFormat<ItineraryModel>({
  stops: ['label', '2024-05-06T07:08:09.000Z'],
  leg: ['gate', '2024-05-07T08:09:10.000Z'],
  held: ['2024-05-08T09:10:11.000Z'],
});
const stops: [] | [string] | [string, ...Date[]] = itinerary.stops;
const leg: [] | [string] | [string, Date] = itinerary.leg;
const held: [] | [Date] = itinerary.held;

void stops; void leg; void held;
