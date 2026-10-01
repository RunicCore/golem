import { literal, tsSource, type SourceFragment } from '../../source-template.js';

export function projectionPolicyModelSource(options: {
  readonly itemExact: boolean;
  readonly containerExact: boolean;
}): SourceFragment {
  return tsSource`
import type { IModel } from '@exprtlabs/golem/model';
import { ContainerBase, ItemBase } from './item.model.generated.js';
export type TItem = IModel<{ id: string; value: string }, { exact: ${literal(options.itemExact)} }>;
export type TContainer = IModel<{ item: Omit<TItem, 'id'> }, { exact: ${literal(options.containerExact)} }>;
export class Container extends ContainerBase {}
export class Item extends ItemBase {}
`;
}

const serdeCodecs = tsSource`
export function encodeAddress(value: { id: string; city: string }): string { return value.city; }
export function decodeAddress(value: string): { id: string; city: string } { return { id: 'decoded', city: value }; }
`;

const validationCodecs = tsSource`
export function validAddress(_value: unknown): boolean { return true; }
`;

const serdeMetadata = tsSource`
import type { encodeAddress, decodeAddress } from './codecs.js';
type AddressFields = { id: string; city: string } & TSerde<typeof encodeAddress, typeof decodeAddress>;
`;

const validationMetadata = tsSource`
import type { validAddress } from './codecs.js';
type AddressFields = { id: string; city: string } & TValidation<typeof validAddress>;
`;

/** The module a whole-object serde or validation function lives in; a model file cannot declare it. */
export function discardedProjectionCodecsSource(options: {
  readonly metadata: 'serde' | 'validation';
}): SourceFragment {
  return options.metadata === 'serde' ? serdeCodecs : validationCodecs;
}

export function discardedProjectionMetadataSource(options: {
  readonly metadata: 'serde' | 'validation';
}): SourceFragment {
  const metadata: SourceFragment = options.metadata === 'serde' ? serdeMetadata : validationMetadata;
  return tsSource`
import type { IModel } from '@exprtlabs/golem/model';
import type { TSerde, TValidation } from '@exprtlabs/golem/tags';
import { AddressBase, ContainerBase } from './item.model.generated.js';
${metadata}
export type TAddress = IModel<AddressFields>;
export type TContainer = IModel<{ projected: Omit<TAddress, 'id'> }>;
export class Address extends AddressBase {}
export class Container extends ContainerBase {}
`;
}
