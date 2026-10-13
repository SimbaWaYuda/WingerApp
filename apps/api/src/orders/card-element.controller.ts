import { Controller, Get, Header, Query } from '@nestjs/common';
import { cardElementHtml } from './card-element.page';

@Controller('payments')
export class CardElementController {
  @Get('card-element')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', 'frame-ancestors *')
  page(@Query('key') key?: string) {
    return cardElementHtml(key);
  }
}
