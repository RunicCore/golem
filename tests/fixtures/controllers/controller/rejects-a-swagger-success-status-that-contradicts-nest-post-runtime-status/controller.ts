
import { Controller, Post } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';

class ResultDto { id!: string; }

@Controller('status-conflict')
export class StatusConflictController {
  @Post()
  @ApiOkResponse({ type: ResultDto })
  create(): ResultDto { return { id: 'ok' }; }
}
