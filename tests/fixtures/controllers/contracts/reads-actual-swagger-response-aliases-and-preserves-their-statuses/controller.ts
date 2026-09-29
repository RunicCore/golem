
import { Controller, Delete, Get, HttpCode, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';

class ResultDto { id!: string; }

@Controller('aliases')
export class AliasController {
  @Get('ok')
  @ApiOkResponse({ type: ResultDto, description: 'ok' })
  ok(): ResultDto { return { id: 'ok' }; }

  @Post('created')
  @ApiCreatedResponse({ type: ResultDto, description: 'created' })
  created(): ResultDto { return { id: 'created' }; }

  @Get('text')
  @ApiOkResponse({ schema: { type: 'string' }, description: 'text' })
  text(): string { return 'text'; }

  @Delete('empty')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'empty' })
  empty(): void {}
}
