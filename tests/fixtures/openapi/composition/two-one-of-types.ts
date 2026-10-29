import { fromWireFormat } from '@exprtlabs/golem/serde';
import { VisitModel } from './index.js';

const visit = fromWireFormat<VisitModel>({ m: { kind: 'b', b: 'p', mode: 'y', y: 'q' } });
const variant: string = visit.m.kind === 'a' ? visit.m.a : visit.m.b;
const mode: string = visit.m.mode === 'x' ? visit.m.x : visit.m.y;

void variant;
void mode;
