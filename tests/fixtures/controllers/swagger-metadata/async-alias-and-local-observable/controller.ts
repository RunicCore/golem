import { Controller, Get } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';

type Page<T> = Promise<T[]>;
type Envelope<T> = Promise<Wrapper<T>>;

class Wrapper<T> {
  @ApiProperty({ description: 'Wrapped total' })
  total!: number;

  data!: T;
}

/** A project class that merely shares rxjs's name; it is the response itself. */
class Observable<T> {
  current!: T;
}

class ItemDto {
  @ApiProperty({ description: 'Item id' })
  id!: string;
}

@Controller('items')
export class ItemsController {
  @Get()
  async list(): Page<ItemDto> {
    return [];
  }

  @Get('wrapped')
  async wrapped(): Envelope<ItemDto> {
    return { total: 0, data: { id: 'x' } };
  }

  @Get('latest')
  latest(): Observable<ItemDto> {
    return { current: { id: 'x' } };
  }
}
