import type * as ContractNamespace from './contracts.js';
import type { ReexportedObject } from './contracts.js';
import { ProvenanceBaseModel, type ProvenanceFields } from './provenance.model.generated.js';
import { fromWireFormat } from '@exprtlabs/golem/serde';

export type TProvenance = ContractNamespace.ReexportedModel<{ title: string }>;
export type TPlain = ReexportedObject<{ label: string }>;
export class Provenance extends ProvenanceBaseModel {
  constructor(values: Partial<ProvenanceFields> = {}) { super(values); }
}
export const model = fromWireFormat<Provenance>({ title: "model" });
export const plain = fromWireFormat<TPlain>({ label: "plain" });
