
import { Controller, Get } from '@nestjs/common';
import { ApiProperty, ApiResponse } from '@nestjs/swagger';
import * as Models from './address.index.js';

class CustomerDto {
  @ApiProperty({ type: Models.AddressDto, description: 'Customer address' })
  address!: Models.AddressDto;
}

@Controller('imported-dto')
export class ImportedDtoController {
  @Get()
  @ApiResponse({ type: CustomerDto })
  get(): CustomerDto { return { address: { city: 'Paris' } }; }
}
