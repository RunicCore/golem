import { parse } from '@exprtlabs/golem/serde';
import type { Payment as First } from './payment.model.js';
import type { Payment as Second } from './other/payment.model.js';

declare const text: string;
export const first = parse<First>(text);
export const second = parse<Second>(text);
