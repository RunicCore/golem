import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { CatModel, DerivedModel } from './index.js';

const derived = decodeGeneratedModel(DerivedModel, { pet: { name: 'n', lives: 9 }, pets: [{ name: 'm', lives: 1 }] });
const pet: CatModel | undefined = derived.pet;
const pets: readonly CatModel[] | undefined = derived.pets;

void pet; void pets;
