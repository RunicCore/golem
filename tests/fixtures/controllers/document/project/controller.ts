
import { Controller, Get } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

@Controller('catalog')
export class CatalogController {
  @Get()
  @ApiResponse({ status: 200, schema: { type: 'string' } })
  get(): string { return 'ok'; }
}
