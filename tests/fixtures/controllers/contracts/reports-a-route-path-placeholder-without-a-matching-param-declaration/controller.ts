
import { Controller, Get } from '@nestjs/common';

@Controller('payments')
export class PaymentsController {
  @Get(':id')
  get(): void {}
}
