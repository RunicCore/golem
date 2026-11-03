import { Controller, Get } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Observable, of } from 'rxjs';

class EventDto {
  @ApiProperty({ description: 'Event name' })
  name!: string;
}

@Controller('events')
export class EventsController {
  @Get()
  latest(): Observable<EventDto> {
    return of({ name: 'started' });
  }
}
