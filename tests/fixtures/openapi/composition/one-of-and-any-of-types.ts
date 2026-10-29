import { fromWireFormat } from '@exprtlabs/golem/serde';
import { VisitModel } from './index.js';

const visit = fromWireFormat<VisitModel>({ m: { kind: 'b', b: 'p', at: '1970-01-01T00:00:00.000Z' } });
const variant: string = visit.m.kind === 'a' ? visit.m.a : visit.m.b;
const at: Date = visit.m.at;

void variant;
void at;
