import { fromWireFormat } from '@exprtlabs/golem/serde';
import { DerivedModel } from './index.js';

const derived = fromWireFormat<DerivedModel>({ stamps: ['2024-05-06T07:08:09.000Z'] });
const stamps: readonly Date[] | undefined = derived.stamps;

void stamps;
