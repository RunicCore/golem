// #region temporal-imports
import 'temporal-polyfill/global';
import { fromWireFormat, toWireFormat } from '@exprtlabs/golem/serde';
import { ChargeModel, type ProviderClient } from './sdk/index.js';
// #endregion temporal-imports

// #region read-dates
export async function readSettlementDate(client: ProviderClient, id: string): Promise<Temporal.PlainDate | undefined> {
  const response = await client.getCharge().execute({ path: { id } });
  if (response.status !== 200) return undefined;
  const charge = fromWireFormat<ChargeModel>(response.body);
  return charge.settlesOn; // settlesOn is `format: date`, so it is a Temporal.PlainDate
}
// #endregion read-dates

// #region write-dates
export function describeCharge() {
  const charge = fromWireFormat<ChargeModel>({
    id: 'charge-1',
    status: 'pending',
    money: { amount: '25.00', currency: 'USD' },
    createdAt: '2025-01-02T03:04:05Z',
    settlesOn: '2025-02-01',
  });
  charge.settlesOn = Temporal.PlainDate.from('2025-02-03');
  return toWireFormat<ChargeModel>(charge);
  // { ..., createdAt: '2025-01-02T03:04:05Z', settlesOn: '2025-02-03' }
}
// #endregion write-dates
