import { fromWireFormat } from '@exprtlabs/golem/serde';
import { PersonModel, VisitModel } from './index.js';

const visit = fromWireFormat<VisitModel>({ owner: { name: 'n' } });
const owner: PersonModel = visit.owner;

void owner;
