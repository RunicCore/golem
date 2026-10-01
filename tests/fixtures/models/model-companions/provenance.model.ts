import type * as ContractNamespace from './contracts.js';
import type { ReexportedObject } from './contracts.js';
import { TProvenanceBaseModel, type TProvenanceFields } from './provenance.model.generated.js';
import { fromWireFormat } from '@exprtlabs/golem/serde';

export type TProvenance = ContractNamespace.ReexportedModel<{ title: string }>;
export type TPlain = ReexportedObject<{ label: string }>;
export class Provenance extends TProvenanceBaseModel {
  constructor(values: Partial<TProvenanceFields> = {}) { super(values); }
}
export const model = fromWireFormat<Provenance>({ title: "model" });
export const plain = fromWireFormat<TPlain>({ label: "plain" });
