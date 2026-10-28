import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isGeneratedModelClass, requireRecord, type GeneratedModelClass } from '../openapi/helpers.js';

/** Load the built pets model and its companion from a built project; returns the Owner model and the generated bases of its Cat and Dog variants. */
export async function loadPets(root: string): Promise<{ Owner: GeneratedModelClass; Cat: GeneratedModelClass; Dog: GeneratedModelClass }> {
  const pets = {
    ...requireRecord(await import(pathToFileURL(path.join(root, 'build/pets.model.js')).href), 'pets module'),
    ...requireRecord(await import(pathToFileURL(path.join(root, 'build/pets.model.generated.js')).href), 'pets companion'),
  };
  const model = (name: string): GeneratedModelClass => {
    const value = pets[name];
    if (!isGeneratedModelClass(value)) throw new TypeError(`${name} must be a generated model class`);
    return value;
  };
  return { Owner: model('Owner'), Cat: model('TCatBaseModel'), Dog: model('TDogBaseModel') };
}
