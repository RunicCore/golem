import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { CatModel, DogModel, PetModel } from './index.js';

const pet = decodeGeneratedModel(PetModel, { kind: 'cat', name: 'n', born: '2024-05-06T07:08:09.000Z' });
const variant: CatModel | DogModel = pet;
const born: Date | undefined = variant instanceof CatModel ? variant.born : undefined;

void born;
