import { Controller, Get } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';

interface UploadedBlob {
  buffer: Uint8Array;
  originalname: string;
}

class Base {
  @ApiProperty()
  id!: string;
}

class Derived extends Base {
  @ApiProperty()
  extra!: string;
}

class Item {
  @ApiProperty({ description: 'Item id' })
  id!: string;
}

class UploadDto {
  @ApiProperty({ type: 'string', format: 'binary', description: 'Uploaded file' })
  file!: UploadedBlob;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: Base })
  owner!: Derived;

  @ApiProperty({ type: Item, isArray: true })
  items!: (Item | null)[];

  @ApiProperty({ type: Number, description: 'Opaque payload' })
  payload!: unknown;
}

@Controller('uploads')
export class UploadsController {
  @Get()
  get(): UploadDto {
    throw new Error('not implemented');
  }
}
