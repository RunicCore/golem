import { fromWireFormat } from '@exprtlabs/golem/serde';
import { VisitModel } from './index.js';

const visit = fromWireFormat<VisitModel>({ members: { at: '2024-05-06T07:08:09.000Z', b: '2024-05-07T08:09:10.000Z' } });
const at: Date | undefined = visit.members.at;
const b: Date | undefined = visit.members.b;

void at; void b;
