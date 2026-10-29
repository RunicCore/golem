import { fromWireFormat } from '@exprtlabs/golem/serde';
import { PetModel, VisitModel } from './index.js';

const visit = fromWireFormat<VisitModel>({ pet: null });
const pet: PetModel | null = visit.pet;
visit.pet = null;

void pet;
