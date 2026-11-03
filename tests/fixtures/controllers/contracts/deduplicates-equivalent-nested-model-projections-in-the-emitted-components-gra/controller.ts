
import { Body, Controller, Post } from '@nestjs/common';
import type { IModel } from '@exprtlabs/golem/model';

export type TAddress = IModel<{ id: string; city: string }>;
export type TEnvelope = IModel<{
  omitted: Omit<TAddress, 'id'>;
  selected: Pick<TAddress, 'city'>;
}>;

@Controller('envelopes')
export class EnvelopeController {
  @Post()
  save(@Body() body: TEnvelope): TEnvelope { return body; }
}
