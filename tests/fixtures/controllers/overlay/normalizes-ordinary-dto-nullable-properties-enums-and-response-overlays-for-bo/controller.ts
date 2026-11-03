
import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger';

class ResultDto {
  @ApiProperty({ nullable: true })
  label!: string;

  @ApiProperty({ enum: ['cat', 'dog'], nullable: true })
  kind!: 'cat' | 'dog';
}

@Controller('results')
export class ResultsController {
  @Get()
  @ApiOkResponse({ schema: { nullable: true } })
  get(): ResultDto { return { label: 'ok', kind: 'cat' }; }
}
