import { fromWireFormat } from '@exprtlabs/golem/serde';
import { CatModel, DogModel, VisitModel } from './index.js';

const visit = fromWireFormat<VisitModel>({ pet: { kind: 'dog', name: 'Rex' } });
const pet: DogModel | CatModel = visit.pet;

void pet;
