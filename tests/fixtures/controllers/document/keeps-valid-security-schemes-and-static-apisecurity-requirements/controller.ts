
import { Controller, Get } from '@nestjs/common';
import { ApiResponse, ApiSecurity } from '@nestjs/swagger';

@Controller('catalog')
export class CatalogController {
  @Get()
  @ApiSecurity({ bearer: ['catalog:read'] })
  @ApiResponse({ status: 200, schema: { type: 'string' } })
  get(): string { return 'ok'; }
}
