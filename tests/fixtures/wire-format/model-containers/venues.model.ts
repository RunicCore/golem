import type { IModel } from '@exprtlabs/golem/model';
import type { TSerde } from '@exprtlabs/golem/tags';
import { decodeBytes, encodeBytes } from './codecs.js';
import { TVenueBaseModel, TVenuesBaseModel } from './venues.model.generated.js';

type Bytes = Uint8Array & TSerde<typeof encodeBytes, typeof decodeBytes>;

export type TVenue = IModel<{ town: string }>;
export type TVenues = IModel<{
  dictionary: Record<string, TVenue>;
  tuple: [first: TVenue, ...rest: TVenue[]];
  choice: 'none' | TVenue | null;
  mixed: 'x' | 1 | null | boolean;
  chunks: Bytes[];
}>;

export class Venue extends TVenueBaseModel {}
export class Venues extends TVenuesBaseModel {}
