import { fromWireFormat } from '@exprtlabs/golem/serde';
import { VisitModel } from './index.js';

const visit = fromWireFormat<VisitModel>({ window: null });
const window: { at?: Date } | null = visit.window;
visit.window = null;

void window;
