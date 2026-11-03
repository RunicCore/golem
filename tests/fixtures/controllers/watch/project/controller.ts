import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBody, ApiResponse, ApiTags } from '@nestjs/swagger';
import { routeFor } from './route-helper.js';

interface Item { id: string; }
@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  @Get(routeFor('list'))
  @ApiResponse({ status: 200, schema: { type: 'string' } })
  list(): string { return 'ok'; }

  @Post()
  @ApiBody({ schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } })
  @ApiResponse({ status: 201, schema: { type: 'string' } })
  create(@Body() body: Item): string { return body.id; }
}
