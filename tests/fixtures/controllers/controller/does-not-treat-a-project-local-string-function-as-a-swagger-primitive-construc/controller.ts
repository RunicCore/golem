
import { Controller, Get } from '@nestjs/common';
import { ApiProperty, ApiResponse } from '@nestjs/swagger';

const String = (): string => 'local';
class LocalConstructorDto {
  @ApiProperty({ type: String })
  value!: string;
}

@Controller('local-constructor')
export class LocalConstructorController {
  @Get()
  @ApiResponse({ type: LocalConstructorDto })
  get(): LocalConstructorDto { return { value: 'x' }; }
}
