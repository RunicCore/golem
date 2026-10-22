import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { VisitModel } from './index.js';

const visit = decodeGeneratedModel(VisitModel, { m: { id: '1', kind: 'b', b: 'y' } });
const id: string = visit.m.id;
const at: Date | undefined = visit.m.at;
const variant: string | undefined = visit.m.kind === 'a' ? visit.m.a : visit.m.b;

void id;
void at;
void variant;
