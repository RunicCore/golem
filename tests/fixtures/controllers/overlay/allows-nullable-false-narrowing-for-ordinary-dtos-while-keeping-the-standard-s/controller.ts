
import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger';

class NarrowDto {
  @ApiProperty({ nullable: false })
  label!: string | null;

  @ApiProperty({ enum: ['cat', 'dog', null], nullable: false })
  kind!: 'cat' | 'dog' | null;
}

@Controller('narrow')
export class NarrowController {
  @Get('property')
  property(): NarrowDto { return { label: 'ok', kind: 'cat' }; }

  @Get('response')
  @ApiOkResponse({ schema: { nullable: false } })
  response(): NarrowDto | null { return null; }
}
