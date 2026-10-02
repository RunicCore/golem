import type * as InputSchemas from './input-schemas.js';
import type * as OutputSchemas from './output-schemas.js';
// @ts-expect-error the sibling member requires secret, declared in another member
const siblingWithoutSecret: InputSchemas.AllOfSibling = { id: 'a' };
const sibling: InputSchemas.AllOfSibling = { id: 'a', secret: 's' };
// the writeOnly secret does not exist in the output direction, so only id is required
const siblingOutput: OutputSchemas.AllOfSibling = { id: 'a' };
// @ts-expect-error the member requires name, declared optional by the shared Pet
const createWithoutName: InputSchemas.CreatePet = { tag: 'x' };
const create: InputSchemas.CreatePet = { name: 'n' };
// the shared Pet keeps name optional for every other user
const pet: InputSchemas.Pet = { tag: 'x' };
// @ts-expect-error a nested allOf member still requires name from the shared Pet
const nestedWithoutName: InputSchemas.NestedPet = { owner: 'o' };
// @ts-expect-error a nested allOf member still requires owner declared in a nested sibling
const nestedWithoutOwner: InputSchemas.NestedPet = { name: 'n' };
const nested: InputSchemas.NestedPet = { name: 'n', owner: 'o' };
void nestedWithoutName; void nestedWithoutOwner; void nested;
void siblingWithoutSecret; void sibling; void siblingOutput; void createWithoutName; void create; void pet;
