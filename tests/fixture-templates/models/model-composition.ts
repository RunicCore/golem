import { literal, tsSource, type SourceFragment } from '../../source-template.js';

export function projectionPolicyModelSource(options: {
  readonly itemExact: boolean;
  readonly containerExact: boolean;
}): SourceFragment {
  return tsSource`
import type { IModel } from '@exprtlabs/codegen/model';
import { ContainerBase, ItemBase } from './item.model.generated.js';
export type TItem = IModel<{ id: string; value: string }, { exact: ${literal(options.itemExact)} }>;
export type TContainer = IModel<{ item: Omit<TItem, 'id'> }, { exact: ${literal(options.containerExact)} }>;
export class Container extends ContainerBase {}
export class Item extends ItemBase {}
`;
}

const serdeMetadata = tsSource`
export function encodeAddress(value: { id: string; city: string }): string { return value.city; }
export function decodeAddress(value: string): { id: string; city: string } { return { id: 'decoded', city: value }; }
type AddressFields = { id: string; city: string } & TSerde<typeof encodeAddress, typeof decodeAddress>;
`;

const validationMetadata = tsSource`
export function validAddress(_value: unknown): boolean { return true; }
type AddressFields = { id: string; city: string } & TValidation<typeof validAddress>;
`;

export function discardedProjectionMetadataSource(options: {
  readonly metadata: 'serde' | 'validation';
}): SourceFragment {
  const metadata: SourceFragment = options.metadata === 'serde' ? serdeMetadata : validationMetadata;
  return tsSource`
import type { IModel } from '@exprtlabs/codegen/model';
import type { TSerde, TValidation } from '@exprtlabs/codegen/tags';
import { AddressBase, ContainerBase } from './item.model.generated.js';
${metadata}
export type TAddress = IModel<AddressFields>;
export type TContainer = IModel<{ projected: Omit<TAddress, 'id'> }>;
export class Address extends AddressBase {}
export class Container extends ContainerBase {}
`;
}
