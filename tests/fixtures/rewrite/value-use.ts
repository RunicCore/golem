import { parse } from '@exprtlabs/golem/serde';
import type { TMoney } from './payment.model.js';

declare const texts: string[];
export const decode = parse<TMoney>;
export const decoded = texts.map(parse<TMoney>);
export const optional = parse?.<TMoney>(texts[0]!);
export const direct = parse<TMoney>(texts[0]!);
