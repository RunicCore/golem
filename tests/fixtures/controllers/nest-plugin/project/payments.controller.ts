import { Body, Controller, Get, Post, Query, type PipeTransform } from '@nestjs/common';
import { Payment, type PaymentFilter, type PaymentInput, type TPayment } from './payment.model.js';
const customPipe: PipeTransform = { transform(value: unknown) { return value; } };
@Controller('payments')
export class PaymentsController {
  @Post()
  create(@Body() input: PaymentInput): TPayment { return { id: "1", ...input }; }
  @Post("as-class")
  createAsClass(@Body() input: Payment): number { return input.note.length; }
  @Get()
  list(@Query() filter: PaymentFilter): TPayment[] { return []; }
  @Post("async")
  createAsync(): Promise<TPayment> { return Promise.resolve({ id: "1", note: "raw" }); }
  @Get("async")
  listAsync(): Promise<readonly TPayment[]> { return Promise.resolve([]); }
  @Get("count")
  count(): number { return 0; }
  @Get("either")
  either(): TPayment | string { return "plain"; }
  @Post("batch")
  createBatch(@Body() inputs: PaymentInput[]): number { return inputs.length; }
  @Post("piped")
  createPiped(@Body(customPipe) input: PaymentInput): number { return input.note.length; }
  @Get("piped")
  listPiped(@Query(customPipe) filter: PaymentFilter): number { return filter.limit?.length ?? 0; }
}
