import { Body, Controller, Post } from '@nestjs/common';
import { type TPayment } from './billing/payment.model.js';
@Controller('billing')
export class BillingController {
  @Post()
  create(@Body() input: TPayment): TPayment { return input; }
}