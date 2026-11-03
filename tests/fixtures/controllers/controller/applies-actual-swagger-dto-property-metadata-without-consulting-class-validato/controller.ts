
import { Controller, Get } from '@nestjs/common';
import { ApiHideProperty, ApiProperty, ApiPropertyOptional, ApiResponse } from '@nestjs/swagger';

class AddressDto {
  @ApiProperty({ type: String, description: 'Postal city' })
  city!: string;

  @ApiPropertyOptional({ example: 'FR' })
  country?: string;

  @ApiHideProperty()
  internalToken?: string;
}

@Controller('addresses')
export class AddressesController {
  @Get()
  @ApiResponse({ type: () => AddressDto })
  get(): AddressDto {
    return { city: 'Paris' };
  }
}
