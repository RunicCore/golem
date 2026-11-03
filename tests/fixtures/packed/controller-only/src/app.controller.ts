import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';

@Controller('health')
export class AppController {
  @Get()
  @ApiOperation({ summary: 'Read health status' })
  @ApiOkResponse({ description: 'Current health', schema: { type: 'object', properties: { status: { const: 'ok' } }, required: ['status'] } })
  health(): { status: 'ok' } { return { status: 'ok' }; }
}
