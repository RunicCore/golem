import { fromWireFormat } from '@exprtlabs/golem/serde';
import { VisitModel } from './index.js';

const visit = fromWireFormat<VisitModel>({ m: { kind: 'b', b: 'p', phone: 'n' } });
const variant: string = visit.m.kind === 'a' ? visit.m.a : visit.m.b;
const email: string | undefined = visit.m.email;
const phone: string | undefined = visit.m.phone;

void variant;
void email;
void phone;
