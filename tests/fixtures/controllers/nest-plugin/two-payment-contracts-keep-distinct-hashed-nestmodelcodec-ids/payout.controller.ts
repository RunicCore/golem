import { Body, Controller, Post } from '@nestjs/common';
import { type TPayment } from './payout/payment.model.js';
@Controller('payout')
export class PayoutController {
  @Post()
  create(@Body() input: TPayment): TPayment { return input; }
}