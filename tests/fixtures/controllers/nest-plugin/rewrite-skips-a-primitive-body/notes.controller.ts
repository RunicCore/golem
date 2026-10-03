import { Body, Controller, Post } from '@nestjs/common';
@Controller('notes')
export class NotesController {
  @Post()
  create(@Body() note: string): string { return note; }
}