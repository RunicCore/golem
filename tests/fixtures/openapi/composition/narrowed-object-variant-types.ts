import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { MModel, VisitModel } from './index.js';

const visit = decodeGeneratedModel(VisitModel, { m: { x: { n: 'a' } } });
const x: MModel | undefined = visit.m.x;

void x;
