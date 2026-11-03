import { parse } from '@exprtlabs/golem/serde';
import source wasmSource from './mod.wasm';
import config from './config.json' with { type: 'json' };
import type { Payment } from './payment.model.js' with { 'resolution-mode': 'import' };

declare const text: string;
export const payment = parse<Payment>(text);
export const lazyConfig = () => import('./config.json', { with: { type: 'json' } });
export { config, wasmSource };
