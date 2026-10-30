// Runs inside a generated SDK directory. For each Owner.pet value, reports whether the client accepts it as a request body
// and whether the client accepts it as a response body.
import { PetsClient } from './dist/client.js';

class Stranger { constructor() { this.name = 'Miso'; } }
const cases = {
  taggedPlain: () => ({ kind: 'cat', name: 'Miso' }),
  untaggedPlain: () => ({ name: 'Miso' }),
  untaggedStranger: () => new Stranger(),
  taggedStranger: () => Object.assign(new Stranger(), { kind: 'cat' }),
};
const attempt = async (call) => { try { await call(); return true; } catch { return false; } };
const requestAccepted = (body) => attempt(() => new PetsClient({ baseUrl: 'http://pets.test', fetchImpl: async () => Response.json({ pet: { kind: 'cat', name: 'Miso' } }) }).createOwner().execute({ body }));
const responseAccepted = (wire) => attempt(() => new PetsClient({ baseUrl: 'http://pets.test', fetchImpl: async () => Response.json(wire) }).createOwner().execute({ body: { pet: { kind: 'cat', name: 'Miso' } } }));
const report = {};
for (const [name, make] of Object.entries(cases)) {
  const pet = make();
  report[name] = {
    requestAccepted: await requestAccepted({ pet }),
    responseAccepted: await responseAccepted(JSON.parse(JSON.stringify({ pet }))),
  };
}
let codeGeneration = 'allowed';
try { new Function('return 1'); } catch { codeGeneration = 'blocked'; }
process.stdout.write(JSON.stringify({ codeGeneration, report }));
