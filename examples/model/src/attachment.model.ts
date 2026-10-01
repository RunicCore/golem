// #region class-valued-field
import type { IModel } from '@exprtlabs/golem/model';
import type { TSerde } from '@exprtlabs/golem/tags';
import type { decodeBase64, encodeBase64 } from './base64-codec.js';
import { AttachmentBaseModel } from './attachment.model.generated.js';

export type TAttachment = IModel<{
  name: string;
  content: Uint8Array & TSerde<typeof encodeBase64, typeof decodeBase64>;
}>;

export class Attachment extends AttachmentBaseModel {}
// #endregion class-valued-field
