import { Body, Controller, Post } from '@nestjs/common';
import type { TA } from './a.model.js';
@Controller('constraints')
export class ConstraintController {
  @Post() create(@Body() body: TA): TA { return body; }
}