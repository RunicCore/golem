import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { PersonModel, VisitModel } from './index.js';

const visit = decodeGeneratedModel(VisitModel, { owner: { name: 'n' } });
const owner: PersonModel = visit.owner;

void owner;
