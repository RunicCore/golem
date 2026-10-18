import type { IModel } from '@exprtlabs/golem/model';
import type { TSerde } from '@exprtlabs/golem/tags';
import type { TAa } from './aa.model.js';
import type { TB } from './b.model.js';
import type { readAa, readZ, writeAa, writeZ } from './codecs.js';
import type { TZ } from './z.model.js';

export type TLetters = IModel<{ z: TZ; b: TB; aa: TAa }>;
export type TLetterZ = IModel<{ id: number & TSerde<typeof writeZ, typeof readZ> }>;
export type TLetterB = IModel<{ id: string }>;
export type TLetterAa = IModel<{ id: number & TSerde<typeof writeAa, typeof readAa> }>;
