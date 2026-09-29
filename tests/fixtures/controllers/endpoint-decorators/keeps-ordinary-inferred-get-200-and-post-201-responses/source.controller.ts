
import { Body, Controller, Get, Post } from '@nestjs/common';
class ItemDto { id!: string; }

@Controller('ordinary')
export class OrdinaryController {
  @Get()
  list(): ItemDto { return { id: '1' }; }

  @Post()
  create(@Body() body: ItemDto): ItemDto { return body; }
}
