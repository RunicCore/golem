
import { fromWireFormat, toWireFormat } from '@exprtlabs/golem/serde';
import { CatModel, DogModel, PetModel } from './index.js';
import type { Cat, Dog, Pet } from './types.js';
import type { GeneratedModelResult } from '@exprtlabs/golem/model';

class HandwrittenCat extends CatModel {
  readonly marker = true;
}

const pet = fromWireFormat<GeneratedModelResult<typeof PetModel>>({ kind: 'cat', name: 'Miso' });
const petVariants: CatModel | DogModel = pet;
const cat = fromWireFormat<CatModel>({ kind: 'cat', name: 'Miso' });
const catExact: CatModel = cat;
const dog = fromWireFormat<DogModel>({ kind: 'dog', name: 'Rex' });
const dogExact: DogModel = dog;
const handwritten = fromWireFormat<HandwrittenCat>({ kind: 'cat', name: 'Miso' });
const handwrittenExact: HandwrittenCat = handwritten;

async function checkWireInference(): Promise<void> {
  const petWire: Pet = toWireFormat<GeneratedModelResult<typeof PetModel>>(pet);
  const catWire: Cat = toWireFormat<CatModel>(catExact);
  const dogWire: Dog = toWireFormat<DogModel>(dogExact);
  const handwrittenWire: Cat = toWireFormat<HandwrittenCat>(handwrittenExact);
  void petWire; void catWire; void dogWire; void handwrittenWire;
}

void pet; void petVariants; void cat; void catExact; void dog; void dogExact;
void handwritten; void handwrittenExact; void checkWireInference;
