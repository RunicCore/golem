import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { CatModel, DogModel, VisitModel } from './index.js';

const visit = decodeGeneratedModel(VisitModel, { pet: { kind: 'dog', name: 'Rex' } });
const pet: DogModel | CatModel = visit.pet;

void pet;
