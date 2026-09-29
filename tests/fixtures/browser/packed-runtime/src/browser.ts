import { autorun, configure, isObservableProp, runInAction } from 'mobx';
import { ProfileClient, MoneyModel } from '../sdk/index.js';
import { Cart } from './cart.model.js';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/codegen/conversion';
import { LibError, LibErrorKind } from '@exprtlabs/codegen/errors';
import { getValidator } from '@exprtlabs/codegen/validation';

configure({ enforceActions: 'always' });

async function run() {
  const cart = decodeGeneratedModel(Cart, { money: { amount: 1, currency: 'USD' }, note: 'draft', count: 2, code: 'ff' });
  const amounts: number[] = [];
  const stopMoney = autorun(() => amounts.push(cart.money.amount));
  runInAction(() => { cart.money.amount = 2; });
  const nested = cart.money instanceof MoneyModel && isObservableProp(cart.money, 'amount');
  stopMoney();
  const cartValidator = getValidator(cart);
  const customValidationInitiallyValid = await cartValidator.validate();
  runInAction(() => { cart.count = 0; });
  const customValidationRejectsZero = !(await cartValidator.validate());
  const customValidationError = cartValidator.error('count');
  runInAction(() => { cart.count = 2; });

  const client = new ProfileClient({ baseUrl: location.origin });
  const api = client.getMoney();
  const loading: boolean[] = [];
  const stopLoading = autorun(() => loading.push(api.loading));
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => { warnings.push(values.map(String).join(' ')); };
  try {
    const first = api.execute({ query: { request: 1 } });
    const second = api.execute({ query: { request: 2 } });
    const results = await Promise.all([first, second]);
    let rejected = false;
    try {
      await client.createMoney().execute({ body: { amount: -1, currency: 'USD' } });
    } catch (error) {
      rejected = error instanceof LibError && error.kind === LibErrorKind.Validation;
    }
    const next = await api.execute({ query: { request: 3 } });
    const abortApi = new ProfileClient({ baseUrl: `${location.origin}/abort` }).getMoney();
    const controller = new AbortController();
    const aborted = abortApi.execute({ query: { request: 4 } }, { signal: controller.signal }).then(
      () => false,
      error => error instanceof Error && error.name === 'AbortError',
    );
    await fetch('/abort-started');
    controller.abort();
    const cancelled = await aborted;
    // Browsers reject a native fetch invoked with a non-Window receiver.
    const explicitFetch = await new ProfileClient({ baseUrl: `${location.origin}/explicit-fetch`, fetchImpl: globalThis.fetch })
      .getMoney().execute({ query: { request: 7 } });
    return {
      nested,
      amounts,
      customValidationInitiallyValid,
      customValidationRejectsZero,
      customValidationError,
      decodedCode: cart.code,
      loading: [...loading],
      idle: !api.loading,
      values: results.map(result => result.body.amount),
      next: next.body.amount,
      rejected,
      warnings,
      json: encodeGeneratedModel(cart),
      cancelled,
      abortIdle: !abortApi.loading,
      explicitFetch: explicitFetch.body.amount,
    };
  } finally {
    console.warn = originalWarn;
    stopLoading();
  }
}

const button = document.querySelector('button');
const output = document.querySelector('output');
if (!button || !output) throw new Error('Missing browser fixture controls');
button.addEventListener('click', () => {
  void run().then(result => { output.textContent = JSON.stringify(result); }, error => {
    output.textContent = JSON.stringify({ failure: String(error) });
  });
});
