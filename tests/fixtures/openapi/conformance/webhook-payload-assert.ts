import type { StatusEvent, WebhookReceiveSettlementOperationInput, CallbackReceiveStatusOperationInput } from './types.js';

// A webhook and a callback are payload types of the SDK: their input holds the body as the plain SDK type StatusEvent.
const settlement: WebhookReceiveSettlementOperationInput = { body: { status: 'settled' } };
const callback: CallbackReceiveStatusOperationInput = { body: { status: 'sent' } };
const event: StatusEvent = settlement.body;
void [callback, event];

// @ts-expect-error the body must hold the required status
const missing: WebhookReceiveSettlementOperationInput = { body: {} };
void missing;
