import { Body, Controller, Get, Post } from '@nestjs/common';
import type { TPayment, TPaymentInput } from './payment.model.js';
@Controller('arrays')
export class ArraysController {
  @Get('generic')
  generic(): Array<TPayment> { return []; }
  @Get('promised')
  promised(): Promise<TPayment[]> { return Promise.resolve([]); }
  @Post('batch')
  batch(@Body() inputs: Array<TPaymentInput>): number { return inputs.length; }
  @Post('readonly')
  readonlyBatch(@Body() inputs: readonly TPaymentInput[]): number { return inputs.length; }
  @Post('nested')
  nestedBatch(@Body() inputs: TPaymentInput[][]): number { return inputs.length; }
}
