import { Controller, Get } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';

let dynamicValues = ['x', 'y'];
dynamicValues = ['z'];

class ChoiceDto {
  @ApiProperty({ enum: dynamicValues })
  value!: string;
}

@Controller('choices')
export class ChoicesController {
  @Get()
  get(): ChoiceDto {
    return { value: 'z' };
  }
}
