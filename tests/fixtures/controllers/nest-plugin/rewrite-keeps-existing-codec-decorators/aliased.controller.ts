import { Body, Controller, Post } from '@nestjs/common';
import { nestModelCodec as __golem_nestModelCodec, nestModelReturn as __golem_nestModelReturn } from '@exprtlabs/golem/nest';
import type { TPayment, TPaymentInput } from './payment.model.js';
@Controller('aliased')
export class AliasedController {
  @__golem_nestModelReturn('TPayment_00000000')
  @Post()
  create(@__golem_nestModelCodec('TPaymentInput_00000000') @Body() input: TPaymentInput): TPayment { return { id: '1', ...input }; }
}
