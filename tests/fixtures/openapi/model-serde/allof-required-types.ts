import { fromWireFormat } from '@exprtlabs/golem/serde';
import { VisitModel } from './index.js';

const visit = fromWireFormat<VisitModel>({ window: { at: '2024-05-06T07:08:09.000Z' } });
const at: Date = visit.window.at;

void at;
