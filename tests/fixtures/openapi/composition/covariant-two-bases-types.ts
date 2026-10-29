import { fromWireFormat } from '@exprtlabs/golem/serde';
import { CatModel, DerivedModel } from './index.js';

const derived = fromWireFormat<DerivedModel>({ named: { name: 'n', nick: 'k', lives: 9 } });
const named: CatModel | undefined = derived.named;

void named;
