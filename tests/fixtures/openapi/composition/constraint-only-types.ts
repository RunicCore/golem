import { fromWireFormat } from '@exprtlabs/golem/serde';
import { VisitModel } from './index.js';

const visit = fromWireFormat<VisitModel>({ m: { at: '2024-05-06T07:08:09.000Z' } });
const m: { at?: Date } = visit.m;

void m;
