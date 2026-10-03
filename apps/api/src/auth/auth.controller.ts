import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthUser } from './auth.types';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  login(
    @Body()
    body: {
      email?: string;
      password?: string;
      role?: UserRole;
    },
  ) {
    return this.authService.login(
      String(body.email ?? '').toLowerCase().trim(),
      String(body.password ?? ''),
      body.role,
    );
  }

  @Post('register')
  register(
    @Body()
    body: {
      email?: string;
      password?: string;
      name?: string;
      role?: UserRole;
      supplierId?: string;
      businessName?: string;
      preferredSupplierSlug?: string;
    },
  ) {
    return this.authService.register({
      email: String(body.email ?? '').toLowerCase().trim(),
      password: String(body.password ?? ''),
      name: String(body.name ?? 'Winger User'),
      role: body.role ?? UserRole.CUSTOMER,
      supplierId: body.supplierId,
      businessName: body.businessName,
      preferredSupplierSlug: body.preferredSupplierSlug,
    });
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return this.authService.me(user.sub);
  }

  @Patch('profile')
  @UseGuards(JwtAuthGuard)
  updateProfile(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      name?: string;
      phone?: string;
      city?: string;
      addressLine?: string;
    },
  ) {
    return this.authService.updateProfile(user.sub, body);
  }
}
