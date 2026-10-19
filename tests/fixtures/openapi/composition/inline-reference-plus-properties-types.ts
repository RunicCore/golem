import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { VisitModel } from './index.js';

const visit = decodeGeneratedModel(VisitModel, { m: { at: '2024-05-06T07:08:09.000Z', name: 'x' } });
const at: Date | undefined = visit.m.at;
const name: string | undefined = visit.m.name;

void at; void name;
