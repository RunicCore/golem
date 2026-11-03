import type { IModel } from '@exprtlabs/golem/model';
import type { TSerde } from '@exprtlabs/golem/tags';
import { decodeBytes, decodeLevel, encodeBytes, encodeLevel } from './codecs.js';
import { TStampedBaseModel } from './stamped.model.generated.js';

export type TStamped = IModel<{
  at: Date;
  level: number & TSerde<typeof encodeLevel, typeof decodeLevel>;
  bytes: Uint8Array & TSerde<typeof encodeBytes, typeof decodeBytes>;
  history: Date[];
}>;

export class Stamped extends TStampedBaseModel {}
