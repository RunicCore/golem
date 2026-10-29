import type { ObjectCodec } from '@exprtlabs/golem/serde';
import { createObjectCodec, type ObjectCodecImpl } from '@exprtlabs/golem/internal/model-runtime';

/** Registers the codec of `id` with parts that check nothing and hand each value on. A test passes the parts its case decides. */
export function registerPassThroughCodec(id: string, parts: Partial<ObjectCodecImpl> = {}): ObjectCodec {
  return createObjectCodec(id, {
    stringify: (value) => JSON.stringify(value),
    parse: (text) => JSON.parse(text) as never,
    validate: () => true,
    assert: (value) => value as never,
    toWireFormat: (value) => value,
    fromWireFormat: (wire) => wire as never,
    ...parts,
  });
}
