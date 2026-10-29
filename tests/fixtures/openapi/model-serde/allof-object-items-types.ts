import { fromWireFormat } from '@exprtlabs/golem/serde';
import { VisitModel } from './index.js';

const visit = fromWireFormat<VisitModel>({ entries: [{ a: '2024-05-06T07:08:09.000Z' }] });
const a: Date | undefined = visit.entries[0]?.a;
const b: Date | undefined = visit.entries[0]?.b;

void a; void b;
