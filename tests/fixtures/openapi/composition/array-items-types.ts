import { fromWireFormat } from '@exprtlabs/golem/serde';
import { VisitModel } from './index.js';

const visit = fromWireFormat<VisitModel>({ e: [{ a: '2024-05-06T07:08:09.000Z', b: '2024-05-07T08:09:10.000Z' }] });
const first: { a?: Date } & { b?: Date } | undefined = visit.e[0];

void first;
