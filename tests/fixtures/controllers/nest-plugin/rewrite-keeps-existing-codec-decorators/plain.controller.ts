import { Body, Controller, Get, Post } from '@nestjs/common';
import * as golem from '@exprtlabs/golem/nest';
import { nestModelCodec, nestModelReturn } from '@exprtlabs/golem/nest';
import type { TPayment, TPaymentInput } from './payment.model.js';
@Controller('plain')
export class PlainController {
  @nestModelReturn('TPayment_00000000')
  @Post()
  create(@nestModelCodec('TPaymentInput_00000000') @Body() input: TPaymentInput): TPayment { return { id: '1', ...input }; }
  @golem.nestModelReturn('TPayment_00000000', true)
  @Get()
  list(@golem.nestModelCodec('TPaymentInput_00000000') @Body() input: TPaymentInput): TPayment[] { return [{ id: '1', ...input }]; }
}
