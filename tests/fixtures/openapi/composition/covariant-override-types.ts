import { fromWireFormat } from '@exprtlabs/golem/serde';
import { CatModel, DerivedModel } from './index.js';

const derived = fromWireFormat<DerivedModel>({ pet: { name: 'n', lives: 9 }, pets: [{ name: 'm', lives: 1 }] });
const pet: CatModel | undefined = derived.pet;
const pets: readonly CatModel[] | undefined = derived.pets;

void pet; void pets;
