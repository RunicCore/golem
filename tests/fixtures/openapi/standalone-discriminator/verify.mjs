// Runs inside a generated SDK directory. For each Owner.pet value, reports
// both validators and whether each encoder's wire value decodes back to Cat.
import { getValidator } from '@exprtlabs/codegen/validation';
import * as models from './dist/models.js';

const { CatModel, DogModel, OwnerModel, validateOwner, encodeOwner, toWireFormatOwner, stringifyOwner, parseOwner } = models;
class Stranger { constructor() { this.name = 'Miso'; } }
const cases = {
  taggedPlain: () => ({ kind: 'cat', name: 'Miso' }),
  untaggedCatModel: () => { const cat = new CatModel({ name: 'Miso' }); delete cat.kind; return cat; },
  untaggedPlain: () => ({ name: 'Miso' }),
  untaggedStranger: () => new Stranger(),
  taggedStranger: () => Object.assign(new Stranger(), { kind: 'cat' }),
  catModelForeignTag: () => Object.assign(new CatModel({ name: 'Miso' }), { kind: 'dog', bark: true }),
};
const decodesToCat = (text) => {
  const pet = parseOwner(text).pet;
  return pet instanceof CatModel && !(pet instanceof DogModel);
};
const attempt = (encode) => { try { return decodesToCat(encode()); } catch { return false; } };
const report = {};
for (const [name, make] of Object.entries(cases)) {
  const pet = make();
  const owner = Object.assign(Object.create(OwnerModel.prototype), { pet });
  report[name] = {
    validateCodec: validateOwner({ pet }),
    validateModel: await getValidator(owner).validate(),
    encodeOwner: attempt(() => JSON.stringify(encodeOwner(owner))),
    toWireFormat: attempt(() => JSON.stringify(toWireFormatOwner({ pet }, { validate: false }))),
    stringify: attempt(() => stringifyOwner({ pet }, { validate: false })),
  };
}
let codeGeneration = 'allowed';
try { new Function('return 1'); } catch { codeGeneration = 'blocked'; }
process.stdout.write(JSON.stringify({ codeGeneration, report }));
