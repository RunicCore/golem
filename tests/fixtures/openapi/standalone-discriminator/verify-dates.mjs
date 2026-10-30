// Runs inside a generated SDK: an allOf variant inherits a date-time field from
// its base, and the discriminated union selects the variant. The operations carry each component as a response and as a request body.
import { DatesClient } from './dist/client.js';

const read = async (component, wire) => (await new DatesClient({ baseUrl: 'http://dates.test', fetchImpl: async () => Response.json(wire) })[`get${component}`]().execute({})).body;
const write = async (component, value) => {
  let sent;
  await new DatesClient({ baseUrl: 'http://dates.test', fetchImpl: async (_url, init) => { sent = JSON.parse(init.body); return new Response(null, { status: 204 }); } })[`put${component}`]().execute({ body: value });
  return sent;
};
const base = { id: 'p1', createdAt: '2026-01-01T00:00:00.000Z' };
const card = { ...base, kind: 'card', maskedPan: '1234' };
const isDate = (value) => value instanceof Date && value.toISOString() === base.createdAt;
const report = {
  base: isDate((await read('PaymentBase', base)).createdAt),
  variant: isDate((await read('CardPayment', card)).createdAt),
  union: isDate((await read('Payment', card)).createdAt),
  writeVariant: (await write('CardPayment', await read('CardPayment', card))).createdAt === base.createdAt,
  writeUnion: (await write('Payment', await read('Payment', card))).createdAt === base.createdAt,
  nonObjectIsInput: await read('CardPayment', 'text').then(() => false, (error) => error?.kind === 'validation' && error.causedByInput === true),
  rejectsBadDate: await read('Payment', { ...card, createdAt: 'nope' }).then(() => false, () => true),
};
process.stdout.write(JSON.stringify(report));
