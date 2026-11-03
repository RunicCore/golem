import { Controller, Get, Query } from '@nestjs/common';
import { ApiProperty, ApiQuery } from '@nestjs/swagger';

export enum Order {
  Asc = 'asc',
  Desc = 'desc',
}

const Kinds = { A: 'a', B: 'b' } as const;

export enum Level {
  Low = 1,
  High = 2,
}

class ReportDto {
  @ApiProperty({ type: 'integer', description: 'Row count' })
  count!: number;

  @ApiProperty({ type: Date, description: 'Creation time' })
  createdAt!: Date;

  @ApiProperty({ enum: [Order.Asc, Order.Desc] })
  order!: Order;

  @ApiProperty({ enum: Order })
  wholeOrder!: Order;

  @ApiProperty({ enum: Level })
  level!: Level;

  @ApiProperty({ enum: [Level.Low, Level.High] })
  levels!: Level;

  @ApiProperty({ enum: [Kinds.A, Kinds.B] satisfies readonly string[] })
  kind!: 'a' | 'b';

  @ApiProperty({ type: 'custom-scalar', description: 'Free text' })
  note!: string;
}

@Controller('reports')
export class ReportsController {
  @Get()
  @ApiQuery({ name: 'order', enum: [Order.Asc, Order.Desc] })
  @ApiQuery({ name: 'level', enum: Level })
  @ApiQuery({ name: 'direction', enum: Order, required: false })
  list(@Query('order') order: Order, @Query('level') level: Level): ReportDto {
    return { count: 1, createdAt: new Date(0), order, wholeOrder: order, level, levels: level, kind: 'a', note: '' };
  }
}
