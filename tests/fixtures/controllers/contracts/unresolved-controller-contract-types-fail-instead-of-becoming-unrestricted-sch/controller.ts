
import { Body, Controller, Post } from '@nestjs/common';
import type { MissingContract } from './missing.js';
@Controller('missing')
export class MissingController {
  @Post()
  create(@Body() input: MissingContract): { ok: boolean } { return { ok: true }; }
}
