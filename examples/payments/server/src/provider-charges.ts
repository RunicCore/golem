import { BadGatewayException, Injectable } from '@nestjs/common';
import { createChargeWithKey } from '../provider/charges.js';
import { isProviderUndeclaredResponseError, ProviderClient } from '../provider/sdk/index.js';

export interface ProviderOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

/** Charges each saved payment through the client generated from provider.yaml. */
@Injectable()
export class ProviderCharges {
  private readonly client: ProviderClient;

  public constructor({ baseUrl = process.env.PROVIDER_URL ?? 'http://127.0.0.1:3001', token = process.env.PROVIDER_TOKEN ?? 'dev-token', fetchImpl }: ProviderOptions = {}) {
    this.client = new ProviderClient({ baseUrl, auth: { bearerAuth: token }, ...(fetchImpl && { fetchImpl }) });
  }

  public async charge(money: { amount: string; currency: string }, idempotencyKey: string) {
    try {
      // The key is the Idempotency-Key header parameter of createCharge, set per call.
      const response = await createChargeWithKey(this.client, money, idempotencyKey);
      return { id: response.body.id, status: response.body.status, settlesOn: response.body.settlesOn.toString() };
    } catch (error) {
      if (isProviderUndeclaredResponseError(error)) {
        throw new BadGatewayException('The payment provider declined or is unavailable.');
      }
      throw error;
    }
  }
}
