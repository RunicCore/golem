
import { Controller, Delete, Get, Head, HttpCode, HttpStatus, Options, Patch, Post, Put, VERSION_NEUTRAL as Neutral, Version } from '@nestjs/common';

@Controller('status')
export class StatusController {
  @Version('1')
  @Get('get')
  get(): void {}

  @Version('1')
  @Post('post')
  post(): void {}

  @Version('1')
  @Put('put')
  put(): void {}

  @Version('1')
  @Patch('patch')
  patch(): void {}

  @Version('1')
  @Delete('delete')
  remove(): void {}

  @Version('1')
  @Options('options')
  options(): void {}

  @Version('1')
  @Head('head')
  head(): void {}

  @Version(Neutral)
  @Get('neutral')
  neutral(): void {}

  @Get('empty')
  @HttpCode(HttpStatus.NO_CONTENT)
  empty(): void {}
}
