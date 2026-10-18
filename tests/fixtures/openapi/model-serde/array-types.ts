import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { VisitModel } from './index.js';

const visit = decodeGeneratedModel(VisitModel, { visits: ['2024-05-06T07:08:09.000Z'] });
const visits: Date[] = visit.visits;

void visits;
