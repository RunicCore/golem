import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { VisitModel } from './index.js';

const visit = decodeGeneratedModel(VisitModel, { window: { b: '2024-05-07T08:09:10.000Z' } });
const window: { at?: Date } | null = visit.window;

void window;
