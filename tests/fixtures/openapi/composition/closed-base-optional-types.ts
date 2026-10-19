import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { DerivedModel } from './index.js';

const derived = decodeGeneratedModel(DerivedModel, { a: 'x' });
const a: string | undefined = derived.a;
const b: Date | undefined = derived.b;

void a; void b;
