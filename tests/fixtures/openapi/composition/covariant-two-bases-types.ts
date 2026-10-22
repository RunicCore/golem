import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { CatModel, DerivedModel } from './index.js';

const derived = decodeGeneratedModel(DerivedModel, { named: { name: 'n', nick: 'k', lives: 9 } });
const named: CatModel | undefined = derived.named;

void named;
