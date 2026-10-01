
import type { IModel } from '@exprtlabs/golem/model';
import { EmailBaseModel, PhoneBaseModel, ContactBookBaseModel } from './contacts.model.generated.js';
export type TEmail = IModel<{ kind: 'email'; address: string }>;
export type TPhone = IModel<{ kind: 'phone'; number: string }>;
type Contact = TEmail | TPhone;
export type TContactBook = IModel<{
 contact: Contact;
 selected: Extract<Contact, {kind:'email'}>;
 excluded: Exclude<Contact, {kind:'phone'}>;
}>;
export class Email extends EmailBaseModel {}
export class Phone extends PhoneBaseModel {}
export class ContactBook extends ContactBookBaseModel {}
