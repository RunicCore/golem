import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { VisitModel } from './index.js';

const visit = decodeGeneratedModel(VisitModel, { either: '2024-05-07T08:09:10.000Z' });
const either: Date | null = visit.either;

void either;
