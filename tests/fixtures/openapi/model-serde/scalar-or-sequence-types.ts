import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { VisitModel } from './index.js';

const visit = decodeGeneratedModel(VisitModel, { plainOrDates: 'plain', plainOrLeg: null });
const plainOrDates: string | Date[] | null = visit.plainOrDates;
const plainOrLeg: string | [] | [Date] | null = visit.plainOrLeg;

void plainOrDates; void plainOrLeg;
