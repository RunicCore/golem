import { Injectable } from '@nestjs/common';
import { createClientWithIdempotencyKey } from '../provider/client.js';

export interface ProviderOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

/** Charges each saved payment through the client generated from provider.yaml. */
@Injectable()
export class ProviderCharges {
  public constructor(private readonly options: ProviderOptions = {}) {}

  public async charge(money: { amount: string; currency: string }, idempotencyKey: string) {
    const { baseUrl = process.env.PROVIDER_URL ?? 'http://127.0.0.1:3001', token = process.env.PROVIDER_TOKEN ?? 'dev-token', fetchImpl } = this.options;
    // One key per payment: retrying the same payment never charges twice.
    const client = createClientWithIdempotencyKey(baseUrl, token, idempotencyKey, fetchImpl ? { fetchImpl } : {});
    const response = await client.createCharge().execute({ body: money });
    return { id: response.body.id, status: response.body.status, settlesOn: response.body.settlesOn.toString() };
  }
}
