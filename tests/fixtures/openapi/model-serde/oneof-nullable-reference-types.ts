import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { PetModel, VisitModel } from './index.js';

const visit = decodeGeneratedModel(VisitModel, { either: { name: 'Miso' } });
const either: PetModel | string = visit.either;

void either;
