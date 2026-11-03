// Thanh toán — đơn hàng
import { parse } from '@exprtlabs/golem/serde';
import type { TMoney } from './payment.model.js';

declare const text: string;
export const label = 'đơn hàng';
export const money = parse<TMoney>(text);
export const next = 1;
