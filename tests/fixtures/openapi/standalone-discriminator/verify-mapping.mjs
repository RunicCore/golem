// Runs inside a generated SDK. The operation validates its body against the
// discriminated Pet union before fetch; report which bodies reached fetch.
import { NamesClient } from './dist/client.js';

let requests = 0;
const client = new NamesClient({
  baseUrl: 'http://pets.test',
  fetchImpl: async () => {
    requests += 1;
    return new Response(null, { status: 200 });
  },
});
const bodies = {
  cat: { kind: 'cat', name: 'Miso' },
  dog: { kind: 'dog', bark: true },
  dogTagWithCatFields: { kind: 'dog', name: 'Miso' },
  unknownTag: { kind: 'bird', name: 'Miso' },
};
const report = {};
for (const [name, body] of Object.entries(bodies)) {
  const before = requests;
  try { await client.createPet().execute({ body }); } catch { /* rejected before or after fetch */ }
  report[name] = requests > before;
}
process.stdout.write(JSON.stringify(report));
