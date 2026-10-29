import { fromWireFormat } from '@exprtlabs/golem/serde';
import { MModel, VisitModel } from './index.js';

const visit = fromWireFormat<VisitModel>({ m: { x: { n: 'a' } } });
const x: MModel | undefined = visit.m.x;

void x;
