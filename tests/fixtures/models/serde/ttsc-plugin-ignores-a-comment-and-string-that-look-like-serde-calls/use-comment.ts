import { stringify } from '@exprtlabs/codegen/serde';
import type { TMoney } from './money.model.js';
import './money.model.js';
export const note = "parse<Foo>(";
// parse<Foo>(
export const text = stringify<TMoney>({ currency: 'USD', value: '1' });