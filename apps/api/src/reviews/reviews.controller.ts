import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AuthUser } from '../auth/auth.types';
import { UserRole } from '@prisma/client';
import {
  CreateSupplierReviewDto,
  ReviewsService,
} from './reviews.service';

@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateSupplierReviewDto,
  ) {
    return this.reviewsService.create(body, user);
  }

  @Get('supplier/:supplierId')
  listForSupplier(@Param('supplierId') supplierId: string) {
    return this.reviewsService.listForSupplier(supplierId);
  }
}
