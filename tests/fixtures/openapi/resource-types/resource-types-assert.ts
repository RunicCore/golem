
import type * as InputSchemas from './input-schemas.js';
import type * as OutputSchemas from './output-schemas.js';
import type {
  Envelope,
  PutEnvelopeOperationInput,
  PutEnvelopeOperationSuccessBody,
  GetEmbeddedOperationSuccessBody,
} from './types.js';

const requestUser: InputSchemas.User = { id: 'u1', secret: 's' };
const replyUser: OutputSchemas.User = { id: 'u1', serverValue: 'ok' };
const input: PutEnvelopeOperationInput = {
  body: { user: requestUser, relative: requestUser },
};
const success: PutEnvelopeOperationSuccessBody = {
  user: replyUser,
  relative: replyUser,
};
const embedded: GetEmbeddedOperationSuccessBody = { id: 'e1' };
const envelope: Envelope = {
  user: { id: 'u1', secret: 's', serverValue: 'ok' },
  relative: { id: 'u1', secret: 's', serverValue: 'ok' },
  scoped: { inner: { id: 'scoped' } },
};
void requestUser; void replyUser; void input; void success; void embedded; void envelope;

const scopedWithInner: NonNullable<Envelope['scoped']> = { inner: { id: 'scoped' } };
const scopedEmpty: NonNullable<Envelope['scoped']> = {};
void scopedWithInner; void scopedEmpty;
// @ts-expect-error scoped.inner resolves to the ScopeUser schema, not an unconstrained placeholder
const scopedWrongInner: NonNullable<Envelope['scoped']> = { inner: { random: true } };
void scopedWrongInner;

// @ts-expect-error URI $ref user requires component fields
const emptyUser: Envelope['user'] = {};
// @ts-expect-error the relative $ref also resolves to the User schema, not an unconstrained placeholder
const emptyRelative: Envelope['relative'] = {};
// @ts-expect-error input cannot include readOnly serverValue
const inputReadOnly: InputSchemas.User = { id: 'u1', secret: 's', serverValue: 'no' };
// @ts-expect-error input is missing writeOnly secret
const inputMissingWriteOnly: InputSchemas.User = { id: 'u1' };
// @ts-expect-error output cannot include writeOnly secret
const outputWriteOnly: OutputSchemas.User = { id: 'u1', serverValue: 'ok', secret: 's' };
void emptyUser; void emptyRelative; void inputReadOnly; void inputMissingWriteOnly; void outputWriteOnly;
