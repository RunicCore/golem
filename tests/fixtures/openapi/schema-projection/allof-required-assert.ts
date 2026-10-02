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
// @ts-expect-error every branch of the union requires method
const paymentWithoutMethod: InputSchemas.Payment = { last4: '1234' };
const card: InputSchemas.Payment = { method: 'card', last4: '1234' };
const bank: InputSchemas.Payment = { method: 'bank', iban: 'x' };
// @ts-expect-error a referenced branch requires method too
const referencedWithoutMethod: InputSchemas.ReferencedPayment = { last4: '1234' };
const referencedCard: InputSchemas.ReferencedPayment = { method: 'card', last4: '1234' };
const referencedBank: InputSchemas.ReferencedPayment = { method: 'bank', iban: 'x' };
// @ts-expect-error a union inside a nested allOf requires method too
const nestedPaymentWithoutMethod: InputSchemas.NestedPayment = { iban: 'x' };
const nestedPayment: InputSchemas.NestedPayment = { method: 'bank', iban: 'x' };
// the shared Card keeps method optional for every other user
const plainCard: InputSchemas.Card = { last4: '1234' };
void paymentWithoutMethod; void card; void bank;
void referencedWithoutMethod; void referencedCard; void referencedBank;
void nestedPaymentWithoutMethod; void nestedPayment; void plainCard;
// @ts-expect-error a schema's own required binds every oneOf branch
const plainWithoutMethod: InputSchemas.PlainPayment = { last4: '1234' };
const plainCard2: InputSchemas.PlainPayment = { method: 'card', last4: '1234' };
const plainBank: InputSchemas.PlainPayment = { method: 'bank', iban: 'x' };
// @ts-expect-error a referenced oneOf branch requires method too
const plainReferencedWithoutMethod: InputSchemas.PlainReferencedPayment = { last4: '1234' };
const plainReferencedCard: InputSchemas.PlainReferencedPayment = { method: 'card', last4: '1234' };
// @ts-expect-error a schema's own required binds every anyOf branch
const anyWithoutMethod: InputSchemas.AnyPayment = { iban: 'x' };
const anyBank: InputSchemas.AnyPayment = { method: 'bank', iban: 'x' };
void plainWithoutMethod; void plainCard2; void plainBank;
void plainReferencedWithoutMethod; void plainReferencedCard;
void anyWithoutMethod; void anyBank;
