import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { OrderStatus, UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AuthUser } from '../auth/auth.types';
import {
  CreateOrderDto,
  OrdersService,
  UpdateItemStatusDto,
  ValidateCartDto,
} from './orders.service';

@Controller('orders')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post('validate')
  @Roles(UserRole.CUSTOMER)
  validate(@CurrentUser() user: AuthUser, @Body() body: ValidateCartDto) {
    return this.ordersService.validateCart(body, user);
  }

  @Post()
  @Roles(UserRole.CUSTOMER)
  create(@CurrentUser() user: AuthUser, @Body() body: CreateOrderDto) {
    return this.ordersService.create(body, user);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.ordersService.list(user);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.ordersService.findOne(id, user);
  }

  @Patch(':orderId/items/:itemId')
  @Roles(UserRole.SUPPLIER, UserRole.ADMIN)
  updateItem(
    @CurrentUser() user: AuthUser,
    @Param('orderId') orderId: string,
    @Param('itemId') itemId: string,
    @Body() body: UpdateItemStatusDto,
  ) {
    if (
      body.status != null &&
      !Object.values(OrderStatus).includes(body.status)
    ) {
      throw new BadRequestException('Invalid order item status');
    }
    if (body.status == null && !body.collectPayment) {
      throw new BadRequestException('status or collectPayment is required');
    }
    return this.ordersService.updateItemStatus(orderId, itemId, body, user);
  }
}
