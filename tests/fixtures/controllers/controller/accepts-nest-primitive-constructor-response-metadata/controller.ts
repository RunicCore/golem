
import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';

@Controller('primitive')
export class PrimitiveController {
  @Get()
  @ApiOkResponse({ type: String })
  value(): string {
    return 'ok';
  }
}
