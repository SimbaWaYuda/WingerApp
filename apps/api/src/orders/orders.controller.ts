import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  OrderStatus,
  ReturnRefundStatus,
  ReturnRequestStatus,
  UserRole,
} from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AuthUser } from '../auth/auth.types';
import {
  CreateOrderDto,
  CreateReturnRequestDto,
  OrdersService,
  UpdateItemStatusDto,
  UpdateReturnRequestDto,
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

  @Get('admin/dashboard')
  @Roles(UserRole.ADMIN)
  adminDashboard(@CurrentUser() user: AuthUser) {
    return this.ordersService.getAdminDashboard(user);
  }

  @Get('returns')
  @Roles(UserRole.SUPPLIER, UserRole.ADMIN)
  listReturns(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
  ) {
    return this.ordersService.listReturnsInbox(user, status);
  }

  @Get('returns/overview')
  @Roles(UserRole.SUPPLIER, UserRole.ADMIN)
  returnsOverview(@CurrentUser() user: AuthUser) {
    return this.ordersService.listReturnsOverview(user);
  }

  @Patch('returns/:returnId')
  @Roles(UserRole.SUPPLIER, UserRole.ADMIN)
  updateReturn(
    @CurrentUser() user: AuthUser,
    @Param('returnId') returnId: string,
    @Body() body: UpdateReturnRequestDto,
  ) {
    if (body.status == null && body.refundStatus == null) {
      throw new BadRequestException('status or refundStatus is required');
    }
    if (
      body.status != null &&
      !Object.values(ReturnRequestStatus).includes(body.status)
    ) {
      throw new BadRequestException('Valid status is required');
    }
    if (
      body.refundStatus != null &&
      !Object.values(ReturnRefundStatus).includes(body.refundStatus)
    ) {
      throw new BadRequestException('Valid refundStatus is required');
    }
    return this.ordersService.updateReturnRequest(returnId, body, user);
  }

  @Post(':id/cancel')
  @Roles(UserRole.CUSTOMER)
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.ordersService.cancel(id, user);
  }

  @Post(':id/returns')
  @Roles(UserRole.CUSTOMER)
  createReturn(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: CreateReturnRequestDto,
  ) {
    return this.ordersService.createReturnRequest(id, body, user);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.ordersService.findOne(id, user);
  }

  @Post(':orderId/items/:itemId/replacement')
  @Roles(UserRole.SUPPLIER, UserRole.ADMIN)
  createReplacement(
    @CurrentUser() user: AuthUser,
    @Param('orderId') orderId: string,
    @Param('itemId') itemId: string,
    @Body() body: { quantity?: number },
  ) {
    return this.ordersService.createReplacementOrder(
      orderId,
      itemId,
      user,
      body?.quantity,
    );
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
