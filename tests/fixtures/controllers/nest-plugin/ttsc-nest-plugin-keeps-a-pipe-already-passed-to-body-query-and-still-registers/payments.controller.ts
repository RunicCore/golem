import { Body, Controller, Get, Post, Query, type PipeTransform } from '@nestjs/common';
import { type PaymentFilter, type PaymentInput, type TPayment } from './payment.model.js';
const customPipe: PipeTransform = { transform(value: unknown) { return value; } };
@Controller('payments')
export class PaymentsController {
  @Post()
  create(@Body(customPipe) input: PaymentInput): TPayment { return { id: "1", ...input }; }
  @Get()
  list(@Query(customPipe) filter: PaymentFilter): TPayment[] { return []; }
}