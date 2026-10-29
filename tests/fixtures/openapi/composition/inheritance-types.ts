import { fromWireFormat } from '@exprtlabs/golem/serde';
import { DerivedModel } from './index.js';

const derived = fromWireFormat<DerivedModel>({ baseAt: '2024-05-06T07:08:09.000Z', derivedAt: '2024-05-07T08:09:10.000Z' });
const baseAt: Date = derived.baseAt;
const derivedAt: Date = derived.derivedAt;
const label: string | undefined = derived.label;

void baseAt; void derivedAt; void label;
