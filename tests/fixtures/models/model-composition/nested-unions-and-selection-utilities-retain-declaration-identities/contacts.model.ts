
import type { IModel } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';
import { TEmailBaseModel, TPhoneBaseModel, TContactBookBaseModel } from './contacts.model.generated.js';
export type TEmail = IModel<{ kind: 'email'; address: string }>;
export type TPhone = IModel<{ kind: 'phone'; number: string }>;
type Contact = TEmail | TPhone;
export type TContactBook = IModel<{
 contact: Contact & Discriminator<'kind'>;
 selected: Extract<Contact, {kind:'email'}>;
 excluded: Exclude<Contact, {kind:'phone'}>;
}>;
export class Email extends TEmailBaseModel {}
export class Phone extends TPhoneBaseModel {}
export class ContactBook extends TContactBookBaseModel {}
