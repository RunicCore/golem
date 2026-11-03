
import { Body, Controller, Post } from '@nestjs/common';
import type { TA } from './a.model.js';
@Controller('contracts')
export class ContractsController {
  @Post() create(@Body() value: TA): TA { return value; }
}
