
import { Controller, Get, Res } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';

@Controller('manual-response')
export class ManualResponseController {
  @Get()
  @ApiOkResponse({ content: { 'application/json': { schema: { type: 'string' } } } })
  send(@Res() response: unknown): void {}
}
