import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { VisitModel } from './index.js';

const visit = decodeGeneratedModel(VisitModel, { m: { a: 'x' } });
const b: undefined = visit.m.b;

void b;
