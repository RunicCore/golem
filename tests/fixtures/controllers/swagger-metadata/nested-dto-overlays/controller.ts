import { Controller, Get, Param } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';

class AddressDto {
  @ApiProperty({ description: 'Street line' })
  street!: string;
}

class ContactDto {
  @ApiProperty({ description: 'Email address' })
  email!: string;
}

class UserDto {
  @ApiProperty({ description: 'Home address' })
  home!: AddressDto;

  @ApiProperty({ description: 'Primary contact' })
  contact!: ContactDto;

  @ApiProperty({ description: 'Backup contact', required: false })
  backup?: ContactDto;
}

@Controller('users')
export class UsersController {
  @Get()
  async list(): Promise<UserDto[]> {
    return [];
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<UserDto> {
    return { home: { street: id }, contact: { email: id } };
  }
}
