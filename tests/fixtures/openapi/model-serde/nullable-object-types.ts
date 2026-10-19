import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { VisitModel } from './index.js';

const visit = decodeGeneratedModel(VisitModel, { window: null });
const window: { at?: Date } | null = visit.window;
visit.window = null;

void window;
