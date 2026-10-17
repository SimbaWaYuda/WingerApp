import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, JwtPayload } from './auth.types';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string, requestedRole?: UserRole) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (requestedRole && user.role !== requestedRole) {
      throw new UnauthorizedException(
        `This account is ${user.role}, not ${requestedRole}`,
      );
    }

    return this.tokenResponse(user);
  }

  async register(input: {
    email: string;
    password: string;
    name: string;
    role: UserRole;
    /** Join an existing supplier (optional). */
    supplierId?: string;
    /** Display name for a new supplier business. */
    businessName?: string;
    /** Optional preferred slug; validated for uniqueness. */
    preferredSupplierSlug?: string;
  }) {
    const email = input.email.toLowerCase().trim();
    if (!email || !input.password || input.password.length < 6) {
      throw new BadRequestException('Valid email and password (6+ chars) required');
    }
    if (!input.name.trim()) {
      throw new BadRequestException('Name is required');
    }
    if (input.role !== UserRole.CUSTOMER && input.role !== UserRole.SUPPLIER) {
      throw new ForbiddenException(
        'Only an existing Winger admin can create an admin account',
      );
    }

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await bcrypt.hash(input.password, 10);

    if (input.role !== UserRole.SUPPLIER) {
      const user = await this.prisma.user.create({
        data: {
          email,
          passwordHash,
          name: input.name.trim(),
          role: input.role,
        },
      });
      return this.tokenResponse(user);
    }

    // Supplier: join existing OR create new business with generated unique id.
    if (input.supplierId) {
      const supplier = await this.prisma.supplier.findUnique({
        where: { id: input.supplierId },
      });
      if (!supplier) {
        throw new BadRequestException('Unknown supplierId');
      }
      const user = await this.prisma.user.create({
        data: {
          email,
          passwordHash,
          name: input.name.trim(),
          role: UserRole.SUPPLIER,
          supplierId: supplier.id,
        },
      });
      return this.tokenResponse(user);
    }

    const businessName = input.businessName?.trim() || input.name.trim();
    if (!businessName) {
      throw new BadRequestException('businessName is required for new suppliers');
    }

    const supplierId = await this.resolveUniqueSupplierId(
      input.preferredSupplierSlug,
      businessName,
    );

    const user = await this.prisma.$transaction(async (tx) => {
      await tx.supplier.create({
        data: {
          id: supplierId,
          name: businessName,
        },
      });
      return tx.user.create({
        data: {
          email,
          passwordHash,
          name: input.name.trim(),
          role: UserRole.SUPPLIER,
          supplierId,
        },
      });
    });

    return this.tokenResponse(user);
  }

  /** Another admin account. Public signup cannot do this. */
  async createAdmin(
    actor: AuthUser,
    input: { email: string; password: string; name: string },
  ) {
    if (actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'Only an existing Winger admin can create an admin account',
      );
    }
    const email = input.email.toLowerCase().trim();
    const name = input.name.trim();
    if (!email || !input.password || input.password.length < 6) {
      throw new BadRequestException('Valid email and password (6+ chars) required');
    }
    if (!name) {
      throw new BadRequestException('Name is required');
    }
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('Email already registered');
    }
    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(input.password, 10),
        name,
        role: UserRole.ADMIN,
      },
    });
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  /** Preferred slug if unique; otherwise system-generated `s-…` id. */
  private async resolveUniqueSupplierId(
    preferredSlug: string | undefined,
    businessName: string,
  ): Promise<string> {
    const preferred = normalizeSupplierSlug(preferredSlug);
    if (preferred) {
      const id = preferred.startsWith('s-') ? preferred : `s-${preferred}`;
      const taken = await this.prisma.supplier.findUnique({ where: { id } });
      if (taken) {
        throw new ConflictException(
          `Supplier id "${id}" is already taken — leave blank for a system id`,
        );
      }
      return id;
    }

    const base = normalizeSupplierSlug(businessName) || 'supplier';
    for (let i = 0; i < 8; i++) {
      const suffix = i === 0 ? '' : `-${i + 1}`;
      const candidate = `s-${base}${suffix}`.slice(0, 48);
      const taken = await this.prisma.supplier.findUnique({
        where: { id: candidate },
      });
      if (!taken) return candidate;
    }

    return `s-${randomBytes(6).toString('hex')}`;
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      supplierId: user.supplierId,
      name: user.name,
      phone: user.phone,
      city: user.city,
      addressLine: user.addressLine,
      preferredLocale: user.preferredLocale,
      displayCurrency: user.displayCurrency,
      profileComplete: user.profileComplete,
      mustChangePassword: user.mustChangePassword,
    };
  }

  async updateProfile(
    userId: string,
    body: {
      name?: string;
      phone?: string;
      city?: string;
      addressLine?: string;
    },
  ) {
    const name = body.name?.trim();
    const phone = body.phone?.trim();
    const city = body.city?.trim();
    const addressLine = body.addressLine?.trim();
    if (!name || !phone || !city || !addressLine) {
      throw new BadRequestException(
        'name, phone, city, and addressLine are required',
      );
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        name,
        phone,
        city,
        addressLine,
        profileComplete: true,
      },
    });

    return this.me(user.id);
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Current password is wrong');
    }
    this.assertPassword(newPassword);
    if (newPassword === currentPassword) {
      throw new BadRequestException('Choose a different password');
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(newPassword, 10),
        passwordResetRequestedAt: null,
        mustChangePassword: false,
      },
    });
    return { ok: true, mustChangePassword: false };
  }

  /** Marks the account. Does not reveal whether the email exists. */
  async requestPasswordReset(email: string) {
    const normalized = email.toLowerCase().trim();
    if (!normalized.includes('@')) {
      throw new BadRequestException('Valid email required');
    }
    const user = await this.prisma.user.findUnique({
      where: { email: normalized },
    });
    if (user) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { passwordResetRequestedAt: new Date() },
      });
    }
    return { ok: true };
  }

  async listPasswordResetRequests(actor: AuthUser) {
    this.assertAdmin(actor);
    const rows = await this.prisma.user.findMany({
      where: { passwordResetRequestedAt: { not: null } },
      select: {
        email: true,
        name: true,
        role: true,
        passwordResetRequestedAt: true,
      },
      orderBy: { passwordResetRequestedAt: 'asc' },
    });
    return {
      requests: rows.map((row) => ({
        email: row.email,
        name: row.name,
        role: row.role,
        requestedAt: row.passwordResetRequestedAt,
      })),
    };
  }

  async resetPassword(
    actor: AuthUser,
    input: { email: string; password: string },
  ) {
    this.assertAdmin(actor);
    this.assertPassword(input.password);
    const email = input.email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new NotFoundException('No account uses that email');
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(input.password, 10),
        passwordResetRequestedAt: null,
        mustChangePassword: true,
      },
    });
    return {
      user: {
        email: user.email,
        name: user.name,
        role: user.role,
        mustChangePassword: true,
      },
    };
  }

  private assertAdmin(actor: AuthUser) {
    if (actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'Only an existing Winger admin can reset a password',
      );
    }
  }

  private assertPassword(password: string) {
    if (!password || password.length < 6) {
      throw new BadRequestException('Password must be at least 6 characters');
    }
  }

  async updatePreferredLocale(userId: string, locale: string) {
    const code = locale.trim().toLowerCase();
    if (code !== 'en' && code !== 'es' && code !== 'sw') {
      throw new BadRequestException('preferredLocale must be en, es, or sw');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { preferredLocale: code },
    });
    return { preferredLocale: code };
  }

  private tokenResponse(user: {
    id: string;
    email: string;
    role: UserRole;
    supplierId: string | null;
    name: string;
    mustChangePassword?: boolean;
  }) {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      supplierId: user.supplierId,
      name: user.name,
    };
    return {
      accessToken: this.jwt.sign(payload),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        supplierId: user.supplierId,
        mustChangePassword: user.mustChangePassword ?? false,
      },
    };
  }
}

function normalizeSupplierSlug(value?: string): string | null {
  if (!value?.trim()) return null;
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/^s-/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || null;
}
