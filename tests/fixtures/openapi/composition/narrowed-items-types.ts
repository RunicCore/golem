import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { DerivedModel } from './index.js';

const derived = decodeGeneratedModel(DerivedModel, { stamps: ['2024-05-06T07:08:09.000Z'] });
const stamps: readonly Date[] | undefined = derived.stamps;

void stamps;
