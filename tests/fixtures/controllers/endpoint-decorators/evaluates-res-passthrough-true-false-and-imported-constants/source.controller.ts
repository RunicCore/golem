
import { Controller, Get, Res, Response } from '@nestjs/common';
import { PASSTHROUGH } from './flags.js';
class ItemDto { id!: string; }

@Controller('passthrough')
export class PassthroughController {
  @Get('true')
  inferred(@Res({ passthrough: true }) response: unknown): ItemDto {
    return { id: 'ok' };
  }

  @Get('alias')
  aliased(@Response({ passthrough: PASSTHROUGH }) response: unknown): ItemDto {
    return { id: 'ok' };
  }
}
