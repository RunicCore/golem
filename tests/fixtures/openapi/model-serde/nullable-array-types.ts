import { fromWireFormat } from '@exprtlabs/golem/serde';
import { VisitModel } from './index.js';

const visit = fromWireFormat<VisitModel>({ visits: null });
const visits: Date[] | null = visit.visits;

void visits;
