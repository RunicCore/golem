import { Controller, Get } from '@nestjs/common';

interface ItemDto { id: string; }

@Controller('items')
export class ItemsController {
  @Get('same')
  first(): ItemDto { return { id: 'first' }; }
}
