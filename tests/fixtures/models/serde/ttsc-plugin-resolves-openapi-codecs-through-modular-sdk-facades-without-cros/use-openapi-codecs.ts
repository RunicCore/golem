import { fromWireFormat } from '@exprtlabs/codegen/serde';
import type { MoneyModel as FirstMoneyModel } from '../sdk-first/index.js';
import * as SecondSdk from '../sdk-second/index.js';
export const first = fromWireFormat<FirstMoneyModel>({ cents: 3 });
export const second = fromWireFormat<SecondSdk.MoneyModel>({ code: 'USD' });