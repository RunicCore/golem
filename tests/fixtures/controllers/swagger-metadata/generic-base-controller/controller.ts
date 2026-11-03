import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';

class User {
  @ApiProperty({ description: 'User identifier' })
  id!: string;

  name!: string;
}

abstract class CrudController<T> {
  @Get(':id')
  async findOne(@Param('id') id: string): Promise<T> {
    throw new Error(id);
  }

  @Post()
  async create(@Body() body: T): Promise<T> {
    return body;
  }
}

@Controller('users')
export class UsersController extends CrudController<User> {}
