
import { Controller, Get } from '@nestjs/common';

@Controller('primitive')
export class PrimitiveController {
  @Get()
  value(): string { return 'value'; }
}
