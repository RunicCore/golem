import type { WireFormat } from '@exprtlabs/golem/serde';
import type { Assert, NotAny, Same } from './wire-assert.js';
import type { All, Place, TAll, TPlace } from './parts.model.js';
import type { TAllJSON, TPlaceJSON } from './parts.model.generated.js';

export type PlaceSame = Assert<Same<WireFormat<TPlace>, TPlaceJSON>>;
export type PlaceClassSame = Assert<Same<WireFormat<Place>, TPlaceJSON>>;
export type AllSame = Assert<Same<WireFormat<TAll>, TAllJSON>>;
export type AllClassSame = Assert<Same<WireFormat<All>, TAllJSON>>;
export type PlaceNotAny = Assert<NotAny<WireFormat<TPlace>>>;
export type AllNotAny = Assert<NotAny<WireFormat<TAll>>>;
