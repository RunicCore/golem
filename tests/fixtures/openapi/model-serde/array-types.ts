import { fromWireFormat } from '@exprtlabs/golem/serde';
import { VisitModel } from './index.js';

const visit = fromWireFormat<VisitModel>({ visits: ['2024-05-06T07:08:09.000Z'] });
const visits: Date[] = visit.visits;

void visits;
