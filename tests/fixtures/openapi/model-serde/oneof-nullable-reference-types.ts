import { fromWireFormat } from '@exprtlabs/golem/serde';
import { PetModel, VisitModel } from './index.js';

const visit = fromWireFormat<VisitModel>({ either: { name: 'Miso' } });
const either: PetModel | string | null = visit.either;

visit.either = null;

void either;
