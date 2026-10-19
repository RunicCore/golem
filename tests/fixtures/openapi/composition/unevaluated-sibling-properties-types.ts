import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { DerivedModel } from './index.js';

const derived = decodeGeneratedModel(DerivedModel, { a: 'x', b: 'y', c: 'z' });
const a: string | undefined = derived.a;
const b: string | undefined = derived.b;
const c: string | undefined = derived.c;

void a; void b; void c;
