import type { InboundInboundPort } from './inbound.js';
import type {
  WebhookReceiveSettlementOperationInput,
  WebhookReceiveSettlementOperationHttpResponse,
  CallbackReceiveStatusOperationInput,
  CallbackReceiveStatusOperationHttpResponse,
} from './types.js';

declare const port: InboundInboundPort;

// Inbound ports are plain async methods the application implements, not ApiOperation
// factories: calling one returns the response directly, with no .execute() to invoke.
const response: Promise<WebhookReceiveSettlementOperationHttpResponse> =
  port.webhookReceiveSettlement({} as WebhookReceiveSettlementOperationInput);
void response;

// A callback port method has the same webhook-like shape as a webhook port method.
const callbackResponse: Promise<CallbackReceiveStatusOperationHttpResponse> =
  port.callbackReceiveStatus({} as CallbackReceiveStatusOperationInput);
void callbackResponse;

// @ts-expect-error a Promise has no .execute; an ApiOperation factory would.
const chained = port.webhookReceiveSettlement({} as WebhookReceiveSettlementOperationInput).execute;
void chained;
