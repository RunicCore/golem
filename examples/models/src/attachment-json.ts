// #region attachment-json
import { fromWireFormat, toWireFormat } from '@exprtlabs/golem/serde';
import { Attachment } from './attachment.model.js';

export function roundTripAttachment() {
  const attachment = new Attachment({ name: 'checksum.bin', content: Uint8Array.of(1, 2, 3) });
  const wire = toWireFormat<Attachment>(attachment);
  const copy = fromWireFormat<Attachment>(wire);

  // -> { wire: { name: 'checksum.bin', content: 'AQID' }, copy }, where copy.content is a Uint8Array
  return { wire, copy };
}
// #endregion attachment-json
