// #region attachment-json
import { fromWireFormat, toWireFormat } from '@exprtlabs/golem/serde';
import { Attachment } from './attachment.model.js';

export function describeAttachment() {
  const attachment = new Attachment({ name: 'checksum.bin', content: Uint8Array.of(1, 2, 3) });
  const wire = toWireFormat<Attachment>(attachment); // { name: 'checksum.bin', content: 'AQID' }
  const copy = fromWireFormat<Attachment>(wire);
  console.log(copy.content instanceof Uint8Array); // true
  return { wire, copy };
}
// #endregion attachment-json
