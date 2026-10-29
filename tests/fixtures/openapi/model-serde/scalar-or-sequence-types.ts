import { fromWireFormat } from '@exprtlabs/golem/serde';
import { VisitModel } from './index.js';

const visit = fromWireFormat<VisitModel>({ plainOrDates: 'plain', plainOrLeg: null });
const plainOrDates: string | Date[] | null = visit.plainOrDates;
const plainOrLeg: string | [] | [Date] | null = visit.plainOrLeg;

void plainOrDates; void plainOrLeg;
