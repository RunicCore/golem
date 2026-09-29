import { stringify } from '@exprtlabs/codegen/serde';
import * as money from './money.model.js';
export const text = stringify<money.TMoney>({ currency: 'USD', value: '1' });