import type { GeneratedModelResult } from '@exprtlabs/golem/model';
import { fromWireFormat } from '@exprtlabs/golem/serde';
import { CatModel, DogModel, PetModel } from './index.js';

// PetModel is the abstract class of a union: the type of its decoded value is the union of its variants.
const pet = fromWireFormat<GeneratedModelResult<typeof PetModel>>({ kind: 'cat', name: 'n', born: '2024-05-06T07:08:09.000Z' });
const variant: CatModel | DogModel = pet;
const born: Date | undefined = variant instanceof CatModel ? variant.born : undefined;

void born;
