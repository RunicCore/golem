import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { PetModel, VisitModel } from './index.js';

const visit = decodeGeneratedModel(VisitModel, { pet: null });
const pet: PetModel | null = visit.pet;
visit.pet = null;

void pet;
