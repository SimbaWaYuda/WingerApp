import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { AuthUser } from './auth.types';

function admin(): AuthUser {
  return {
    sub: 'admin-1',
    email: 'admin@winger.example',
    name: 'Admin',
    role: UserRole.ADMIN,
  };
}

describe('AuthService password reset', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
  };
  const service = new AuthService(prisma as never, {} as never);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('rejects a wrong current password', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      passwordHash: await bcrypt.hash('demo1234', 4),
    });
    await expect(
      service.changePassword('u1', 'wrong', 'another1'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('saves a new hash when the current password matches', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      passwordHash: await bcrypt.hash('demo1234', 4),
    });
    prisma.user.update.mockResolvedValue({});
    await expect(
      service.changePassword('u1', 'demo1234', 'fresh123'),
    ).resolves.toEqual({ ok: true, mustChangePassword: false });
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data.passwordResetRequestedAt).toBeNull();
    expect(data.mustChangePassword).toBe(false);
    expect(await bcrypt.compare('fresh123', data.passwordHash)).toBe(true);
  });

  it('accepts an unknown email without saying the account is missing', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(
      service.requestPasswordReset('missing@example.com'),
    ).resolves.toEqual({ ok: true });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('marks a real account when a reset is requested', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
    prisma.user.update.mockResolvedValue({});
    await service.requestPasswordReset('Amina.Mwangi@example.com');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'amina.mwangi@example.com' },
    });
    expect(prisma.user.update.mock.calls[0][0].data.passwordResetRequestedAt).toBeInstanceOf(
      Date,
    );
  });

  it('refuses a password reset from a customer', async () => {
    await expect(
      service.resetPassword(
        { ...admin(), role: UserRole.CUSTOMER },
        { email: 'a@example.com', password: 'fresh123' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('sets a new password for an existing account', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'kalilo.msuya@axample.com',
      name: 'Kalilo Msuya',
      role: UserRole.CUSTOMER,
    });
    prisma.user.update.mockResolvedValue({});
    const result = await service.resetPassword(admin(), {
      email: 'kalilo.msuya@axample.com',
      password: 'fresh123',
    });
    expect(result.user.email).toBe('kalilo.msuya@axample.com');
    expect(result).not.toHaveProperty('password');
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data.passwordResetRequestedAt).toBeNull();
    expect(data.mustChangePassword).toBe(true);
    expect(result.user).toMatchObject({ mustChangePassword: true });
    expect(await bcrypt.compare('fresh123', data.passwordHash)).toBe(true);
  });

  it('rejects a short password and a missing account', async () => {
    await expect(
      service.resetPassword(admin(), { email: 'a@example.com', password: '123' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(
      service.resetPassword(admin(), {
        email: 'missing@example.com',
        password: 'fresh123',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
