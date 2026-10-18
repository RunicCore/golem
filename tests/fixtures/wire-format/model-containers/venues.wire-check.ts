import type { WireFormat } from '@exprtlabs/golem/serde';
import type { Assert, NotAny, Same } from './wire-assert.js';
import type { TVenue, TVenues, Venue, Venues } from './venues.model.js';
import type { TVenueJSON, TVenuesJSON } from './venues.model.generated.js';

export type VenueSame = Assert<Same<WireFormat<TVenue>, TVenueJSON>>;
export type VenueClassSame = Assert<Same<WireFormat<Venue>, TVenueJSON>>;
export type VenuesSame = Assert<Same<WireFormat<TVenues>, TVenuesJSON>>;
export type VenuesClassSame = Assert<Same<WireFormat<Venues>, TVenuesJSON>>;
export type VenuesNotAny = Assert<NotAny<WireFormat<TVenues>>>;
