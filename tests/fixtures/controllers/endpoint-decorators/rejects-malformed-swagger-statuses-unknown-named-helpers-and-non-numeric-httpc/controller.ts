
import { Controller, Get } from '@nestjs/common';
import { ApiWidgetResponse } from '@nestjs/swagger';
import './swagger-augment.js';
@Controller('unknown-helper')
export class UnknownHelperController {
  @ApiWidgetResponse({ description: 'mystery' })
  @Get()
  get(): void {}
}
