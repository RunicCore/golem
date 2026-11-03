
import { Controller, Get, Param } from '@nestjs/common';
import { ApiBadRequestResponse } from '@nestjs/swagger';
class ItemDto { id!: string; }
class ErrorDto { message!: string; }

@ApiBadRequestResponse({ description: 'class error', type: ErrorDto })
@Controller('catalog')
export class CatalogController {
  @Get()
  list(): ItemDto { return { id: '1' }; }

  @Get(':id')
  @ApiBadRequestResponse({ description: 'method error', type: ErrorDto })
  get(@Param('id') id: string): ItemDto { return { id }; }
}
