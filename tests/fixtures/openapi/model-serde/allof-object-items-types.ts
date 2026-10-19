import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { VisitModel } from './index.js';

const visit = decodeGeneratedModel(VisitModel, { entries: [{ a: '2024-05-06T07:08:09.000Z' }] });
const a: Date | undefined = visit.entries[0]?.a;
const b: Date | undefined = visit.entries[0]?.b;

void a; void b;
