import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { OrdersService } from './orders.service';
import { StripeService } from './stripe.service';

@Controller('stripe')
export class StripeWebhookController {
  constructor(
    private readonly stripe: StripeService,
    private readonly orders: OrdersService,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature?: string,
  ) {
    if (!req.rawBody) {
      throw new BadRequestException('Missing raw body');
    }
    let event;
    try {
      event = this.stripe.constructWebhookEvent(req.rawBody, signature);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid webhook';
      if (message.includes('STRIPE_WEBHOOK_SECRET') || message.includes('not configured')) {
        throw new ServiceUnavailableException('Stripe webhook is not configured');
      }
      throw new BadRequestException('Invalid Stripe signature');
    }
    return this.orders.handleStripeEvent(event);
  }
}
