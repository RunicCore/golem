import { Controller, Get } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, ApiProperty, getSchemaPath } from '@nestjs/swagger';

export enum Kind {
  Bug = 'bug',
  Feature = 'feature',
}

class BugDto {
  @ApiProperty({ enum: Kind, enumName: 'Kind', description: 'Issue kind' })
  kind!: Kind;

  @ApiProperty()
  severity!: number;
}

class FeatureDto {
  @ApiProperty({ enum: Kind, enumName: 'Kind' })
  kind!: Kind;

  @ApiProperty({ type: 'integer' })
  votes!: number;
}

@ApiExtraModels(BugDto, FeatureDto)
@Controller('issues')
export class IssuesController {
  @Get('any')
  @ApiOkResponse({ schema: { oneOf: [{ $ref: getSchemaPath(BugDto) }, { $ref: getSchemaPath(FeatureDto) }] } })
  any(): BugDto | FeatureDto {
    return { kind: Kind.Bug, severity: 2 };
  }
}
