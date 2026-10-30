// #region temporal-imports
import 'temporal-polyfill/global';
import { fromWireFormat, toWireFormat } from '@exprtlabs/golem/serde';
import type { ProviderClient } from './sdk/index.js';
import type { ChargeRecord, TChargeRecord } from './charge-record.model.js';
// #endregion temporal-imports

// #region read-dates
export async function readSettlementDate(client: ProviderClient, id: string): Promise<Temporal.PlainDate | undefined> {
  const response = await client.getCharge().execute({ path: { id } });
  if (response.status !== 200) return undefined;
  return response.body.settlesOn; // settlesOn is `format: date`, so the client returns a Temporal.PlainDate
}
// #endregion read-dates

// #region write-dates
export function describeCharge() {
  const record = fromWireFormat<ChargeRecord>({
    charge: {
      id: 'charge-1',
      status: 'pending',
      money: { amount: '25.00', currency: 'USD' },
      createdAt: '2025-01-02T03:04:05Z',
      settlesOn: '2025-02-01',
    },
  });
  record.charge.settlesOn = Temporal.PlainDate.from('2025-02-03');
  return toWireFormat<TChargeRecord>(record).charge;
  // { ..., createdAt: '2025-01-02T03:04:05Z', settlesOn: '2025-02-03' }
}
// #endregion write-dates
