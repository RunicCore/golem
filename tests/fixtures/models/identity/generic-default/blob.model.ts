import type { IModel } from '@exprtlabs/golem/model';
import type { TSerde } from '@exprtlabs/golem/tags';
import { encodeBytes, decodeBytes } from './codecs.js';

type Bytes = Uint8Array & TSerde<typeof encodeBytes, typeof decodeBytes>;
export type TBlob = IModel<{ bytes: Bytes; copies: Bytes[] }>;
