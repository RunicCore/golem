import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { DerivedModel } from './index.js';

const derived = decodeGeneratedModel(DerivedModel, { deletedAt: '2024-05-06T07:08:09.000Z' });
const deletedAt: Date | undefined = derived.deletedAt;

void deletedAt;
