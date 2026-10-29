import { fromWireFormat } from '@exprtlabs/golem/serde';
import { VisitModel, type Pet } from './index.js';

// The component is an alias of the union of merged objects: its exported type is the wire JSON, and the field is the model type.
const wire: Pet = { id: '1', at: '2024-05-06T07:08:09.000Z', kind: 'a', a: '2024-05-07T08:09:10.000Z' };
const visit = fromWireFormat<VisitModel>({ m: wire });
const id: string = visit.m.id;
const at: Date | undefined = visit.m.at;
const variant: Date | string = visit.m.kind === 'a' ? visit.m.a : visit.m.b;

void id;
void at;
void variant;
