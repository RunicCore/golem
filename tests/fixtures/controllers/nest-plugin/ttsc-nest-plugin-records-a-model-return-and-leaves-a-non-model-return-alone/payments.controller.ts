import { Controller, Get, Post } from '@nestjs/common';
import { type TPayment } from './payment.model.js';
@Controller('payments')
export class PaymentsController {
  @Post()
  create(): Promise<TPayment> { return Promise.resolve({ id: "1", note: "raw" }); }
  @Get()
  list(): Promise<readonly TPayment[]> { return Promise.resolve([]); }
  @Get("count")
  count(): number { return 0; }
  @Get("either")
  either(): TPayment | string { return "plain"; }
}