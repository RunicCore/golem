
import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiConsumes, ApiProduces, ApiQuery, ApiResponse } from '@nestjs/swagger';

class ResultDto {
  email!: string;
}

@Controller('results')
export class ResultsController {
  @Get()
  @ApiQuery({ name: 'term', required: false, default: 'all', description: 'Search term' })
  @ApiProduces('application/json')
  @ApiResponse({ status: 206, type: () => ResultDto, description: 'Partial result' })
  list(@Query('term') term: string): ResultDto {
    return { email: term };
  }

  @Post()
  @HttpCode(202)
  @ApiConsumes('application/json')
  @ApiProduces('application/json', 'application/problem+json')
  create(@Body() body: ResultDto): ResultDto {
    return body;
  }
}
