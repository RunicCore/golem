import { Body, Controller, Post } from '@nestjs/common';
import { parse } from '@exprtlabs/golem/serde';
import type { TPayment, TPaymentInput } from './payment.model.js';
@Controller('mixed')
export class MixedController {
  @Post()
  create(@Body() input: TPaymentInput): TPayment { return parse<TPayment>(JSON.stringify(input)); }
}
