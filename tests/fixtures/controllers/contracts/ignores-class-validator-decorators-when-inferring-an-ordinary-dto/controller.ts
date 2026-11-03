
import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { IsEmail, Min } from 'class-validator';

class ResultDto {
  @IsEmail()
  @Min(10)
  email!: string;
}

@Controller('ordinary')
export class OrdinaryController {
  @Get()
  @ApiOkResponse({ type: ResultDto })
  value(): ResultDto { return { email: 'value' }; }
}
