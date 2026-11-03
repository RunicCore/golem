import { Body, Controller, Post } from '@nestjs/common';
interface Payment { note: string }
@Controller('notes')
export class NotesController {
  @Post()
  create(@Body() input: Payment): Payment { return input; }
}