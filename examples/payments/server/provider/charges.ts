import { fromWireFormat } from '@exprtlabs/golem/serde';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { ChargeModel, isProviderUndeclaredResponseError, ProviderClient } from './sdk/index.js';
import { getCharge } from './sdk/operations/getCharge.js';

// #region create-and-list
export async function listCharges(baseUrl: string, token: string) {
  const client = new ProviderClient({ baseUrl, auth: { bearerAuth: token } });
  const operation = client.listCharges();
  return operation.execute({});
}
// #endregion create-and-list

// #region list-titles
export async function logChargeIds(client: ProviderClient): Promise<string[]> {
  const response = await client.listCharges().execute({});
  for (const charge of response.body) {
    console.log(charge.id); // "charge-1"
  }
  return response.body.map(charge => charge.id);
}
// #endregion list-titles

// #region request-arguments
export async function readChargePage(client: ProviderClient, cursor?: string) {
  return client.listCharges().execute({ query: { limit: 20, cursor } });
}

export async function createCharge(client: ProviderClient, amount: string) {
  return client.createCharge().execute({ body: { amount, currency: 'USD' } });
}
// #endregion request-arguments

// #region read-task
export async function readCharge(client: ProviderClient, id: string) {
  const response = await client.getCharge().execute({ path: { id } });
  if (response.status === 404) {
    return response.body.message; // Declared 404: data from the provider, not a thrown failure.
  }
  return response.body.money.amount; // Status 200 narrows body to the charge type.
}
// #endregion read-task

// #region task-model
export function loadCharge(data: unknown): ChargeModel {
  const charge = fromWireFormat<ChargeModel>(data);
  console.log(charge instanceof ChargeModel); // true
  return charge;
}
// #endregion task-model

// #region invalid-task
export async function createChargeWithAmount(client: ProviderClient, amount: string) {
  try {
    return await client.createCharge().execute({ body: { amount, currency: 'USD' } });
  } catch (error) {
    if (error instanceof LibError && error.kind === LibErrorKind.Validation) {
      // "12,50" violates the amount pattern; issue.path identifies the field.
      return error.issues.map(issue => [issue.code, issue.path, issue.message] as const);
    }
    throw error;
  }
}
// #endregion invalid-task

// #region handle-errors
export async function fetchCharge(client: ProviderClient, id: string) {
  try {
    return await client.getCharge().execute({ path: { id } });
  } catch (error) {
    if (isProviderUndeclaredResponseError(error)) {
      // error.kind === LibErrorKind.Response
      console.error(`Undeclared response for ${id}: HTTP ${error.status}`);
      return undefined;
    }
    throw error; // Network failures reject with the underlying fetch error.
  }
}
// #endregion handle-errors

// #region cancel-request
export async function listWithCancelButton(client: ProviderClient, button: { onclick: (() => void) | null }) {
  const controller = new AbortController();
  const request = client.listCharges().execute({}, { signal: controller.signal });
  button.onclick = () => controller.abort(); // Rejects the pending request; does not cancel other operations.
  try {
    return await request;
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    return undefined;
  }
}
// #endregion cancel-request

// #region standalone-operation
export function readChargeDirectly(baseUrl: string, token: string, id: string) {
  const chargeRequest = getCharge({ baseUrl, auth: { bearerAuth: token } });
  return chargeRequest.execute({ path: { id } });
}
// #endregion standalone-operation

// #region reuse-request
export async function readTwoCharges(client: ProviderClient, firstId: string, secondId: string) {
  const getOne = client.getCharge();
  const first = await getOne.execute({ path: { id: firstId } });
  const second = await getOne.execute({ path: { id: secondId } });
  return { first, second };
}
// #endregion reuse-request
