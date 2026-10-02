import { parse } from './index.js';
import type { TMoney } from './payment.model.js';

declare const text: string;
export const parsed = parse<(TMoney)>(text);
