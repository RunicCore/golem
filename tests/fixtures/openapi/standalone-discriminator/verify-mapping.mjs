// Runs inside a generated SDK. Each operation validates its body against its own discriminated
// union before fetch; report which bodies reached fetch. Argument: JSON of
// { [case]: { operation, bodies: { [name]: body } } }.
import { NamesClient } from './dist/client.js';

let requests = 0;
const client = new NamesClient({
  baseUrl: 'http://pets.test',
  fetchImpl: async () => {
    requests += 1;
    return new Response(null, { status: 200 });
  },
});
const cases = JSON.parse(process.argv[2]);
const report = {};
for (const [label, { operation, bodies }] of Object.entries(cases)) {
  report[label] = {};
  for (const [name, body] of Object.entries(bodies)) {
    const before = requests;
    try { await client[operation]().execute({ body }); } catch { /* rejected before or after fetch */ }
    report[label][name] = requests > before;
  }
}
process.stdout.write(JSON.stringify(report));
