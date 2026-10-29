import { fromWireFormat } from '@exprtlabs/golem/serde';
import { VisitModel } from './index.js';

const visit = fromWireFormat<VisitModel>({ based: { name: 'Miso' } });
const at: Date | undefined = visit.based.at;

void at;
