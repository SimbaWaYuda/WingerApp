import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { Roles } from './roles.decorator';
import { RolesGuard } from './roles.guard';
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

  @Post('password-resets')
  requestPasswordReset(@Body() body: { email?: string }) {
    return this.authService.requestPasswordReset(String(body.email ?? ''));
  }

  @Get('password-resets')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  listPasswordResets(@CurrentUser() user: AuthUser) {
    return this.authService.listPasswordResetRequests(user);
  }

  @Post('password-resets/apply')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  resetPassword(
    @CurrentUser() user: AuthUser,
    @Body() body: { email?: string; password?: string },
  ) {
    return this.authService.resetPassword(user, {
      email: String(body.email ?? ''),
      password: String(body.password ?? ''),
    });
  }

  @Patch('password')
  @UseGuards(JwtAuthGuard)
  changePassword(
    @CurrentUser() user: AuthUser,
    @Body() body: { currentPassword?: string; newPassword?: string },
  ) {
    return this.authService.changePassword(
      user.sub,
      String(body.currentPassword ?? ''),
      String(body.newPassword ?? ''),
    );
  }

  @Post('admins')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  createAdmin(
    @CurrentUser() user: AuthUser,
    @Body() body: { email?: string; password?: string; name?: string },
  ) {
    return this.authService.createAdmin(user, {
      email: String(body.email ?? ''),
      password: String(body.password ?? ''),
      name: String(body.name ?? ''),
    });
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return this.authService.me(user.sub);
  }

  @Patch('locale')
  @UseGuards(JwtAuthGuard)
  updateLocale(
    @CurrentUser() user: AuthUser,
    @Body() body: { preferredLocale?: string },
  ) {
    return this.authService.updatePreferredLocale(
      user.sub,
      String(body.preferredLocale ?? ''),
    );
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
