import { stringify } from '@exprtlabs/golem/serde';
import type { TMoney } from './payment.model.js';

const __golem_requireObjectCodec = 1;
declare const money: TMoney;
export const written = stringify<TMoney>(money);
export { __golem_requireObjectCodec };
