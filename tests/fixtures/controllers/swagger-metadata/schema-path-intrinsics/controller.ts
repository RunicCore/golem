import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiProperty, getSchemaPath, refs } from '@nestjs/swagger';
import { NAME_DESCRIPTION, PREFIX } from './docs.js';

function t(key: string): string {
  return key;
}

class PageMeta {
  @ApiProperty({ description: `${PREFIX} total` })
  total!: number;
}

class Cat {
  @ApiProperty({ description: NAME_DESCRIPTION })
  name!: string;
}

class Dog {
  @ApiProperty({ description: t('dog.bark'), example: new Date() })
  bark!: boolean;
}

@Controller('pets')
export class PetsController {
  @Get()
  @ApiOkResponse({
    schema: {
      allOf: [
        { $ref: getSchemaPath(PageMeta) },
        { properties: { items: { type: 'array', items: { oneOf: refs(Cat, Dog) } } } },
      ],
    },
  })
  list(): void {}
}
