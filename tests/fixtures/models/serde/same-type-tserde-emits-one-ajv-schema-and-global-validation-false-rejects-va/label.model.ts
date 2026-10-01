import type { IObject } from '@exprtlabs/golem/model';
import type { TSerde } from '@exprtlabs/golem/tags';
import type { identity } from './codecs.js';
export type TLabel = IObject<{ name: string & TSerde<typeof identity, typeof identity> }>;
