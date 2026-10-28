import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { VisitModel } from './index.js';

const visit = decodeGeneratedModel(VisitModel, { m: { kind: 'b', b: 'p', mode: 'y', y: 'q' } });
const variant: string = visit.m.kind === 'a' ? visit.m.a : visit.m.b;
const tagged: string = visit.m.mode === 'x' ? visit.m.x : visit.m.y;

void variant;
void tagged;
