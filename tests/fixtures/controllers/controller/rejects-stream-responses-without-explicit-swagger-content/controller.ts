
import { Controller, Get } from '@nestjs/common';

class StreamableFile {}

@Controller('files')
export class FilesController {
  @Get()
  download(): StreamableFile {
    return new StreamableFile();
  }
}
