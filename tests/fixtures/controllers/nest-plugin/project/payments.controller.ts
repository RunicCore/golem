import { Body, Controller, Get, Post, Query, type PipeTransform } from '@nestjs/common';
import { Payment, type TPaymentFilter, type TPaymentInput, type TPayment } from './payment.model.js';
const customPipe: PipeTransform = { transform(value: unknown) { return value; } };
@Controller('payments')
export class PaymentsController {
  @Post()
  create(@Body() input: TPaymentInput): TPayment { return { id: "1", ...input }; }
  @Post("as-class")
  createAsClass(@Body() input: Payment): number { return input.note.length; }
  @Get()
  list(@Query() filter: TPaymentFilter): TPayment[] { return []; }
  @Post("async")
  createAsync(): Promise<TPayment> { return Promise.resolve({ id: "1", note: "raw" }); }
  @Get("async")
  listAsync(): Promise<readonly TPayment[]> { return Promise.resolve([]); }
  @Get("count")
  count(): number { return 0; }
  @Get("either")
  either(): TPayment | string { return "plain"; }
  @Post("batch")
  createBatch(@Body() inputs: TPaymentInput[]): number { return inputs.length; }
  @Post("piped")
  createPiped(@Body(customPipe) input: TPaymentInput): number { return input.note.length; }
  @Get("piped")
  listPiped(@Query(customPipe) filter: TPaymentFilter): number { return filter.limit?.length ?? 0; }
}
