import { fromWireFormat } from '@exprtlabs/golem/serde';
import { VisitModel } from './index.js';

const visit = fromWireFormat<VisitModel>({
  maybeVisits: ['2024-05-06T07:08:09.000Z'],
  untypedVisits: ['2024-05-07T08:09:10.000Z'],
  maybeLeg: ['gate', '2024-05-08T09:10:11.000Z'],
  untypedLeg: ['door', '2024-05-09T10:11:12.000Z'],
});
const maybeVisits: Date[] | null = visit.maybeVisits;
const untypedVisits: Date[] = visit.untypedVisits;
const maybeLeg: [] | [string] | [string, Date] | null = visit.maybeLeg;
const untypedLeg: [] | [string] | [string, Date] = visit.untypedLeg;

void maybeVisits; void untypedVisits; void maybeLeg; void untypedLeg;
