import { fromWireFormat } from '@exprtlabs/golem/serde';
import { DerivedModel } from './index.js';

const derived = fromWireFormat<DerivedModel>({ deletedAt: '2024-05-06T07:08:09.000Z' });
const deletedAt: Date | undefined = derived.deletedAt;

void deletedAt;
