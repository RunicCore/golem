import { Controller, Get } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';

class PingDto {
  @ApiProperty({ description: 'Ping reply' })
  reply!: string;
}

class TimeDto {
  @ApiProperty({ description: 'Epoch millis' })
  at!: number;
}

class BaseController {
  @Get('ping')
  ping(): PingDto {
    return { reply: 'pong' };
  }
}

type Constructor = new (...args: any[]) => object;

function Timestamped<TBase extends Constructor>(Base: TBase) {
  class Mixed extends Base {
    @Get('time')
    time(): TimeDto {
      return { at: 0 };
    }
  }
  return Mixed;
}

@Controller('plain')
export class PlainController extends BaseController {}

@Controller('mixed')
export class MixedController extends Timestamped(BaseController) {}
