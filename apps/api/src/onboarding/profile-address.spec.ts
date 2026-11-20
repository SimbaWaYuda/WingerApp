import { BadRequestException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { OnboardingService } from './onboarding.service';
import { resolveProfileAddressLine } from './profile-address';

describe('resolveProfileAddressLine', () => {
  it('does not store Westlands when addressLine is blank or missing', () => {
    expect(resolveProfileAddressLine(undefined)).toBeNull();
    expect(resolveProfileAddressLine(null)).toBeNull();
    expect(resolveProfileAddressLine('')).toBeNull();
    expect(resolveProfileAddressLine('   ')).toBeNull();
    expect(resolveProfileAddressLine('\t\n')).toBeNull();
    expect(resolveProfileAddressLine(' \t ')).toBeNull();
    expect(resolveProfileAddressLine('Westlands')).toBe('Westlands');
  });

  it('preserves an existing valid street address', () => {
    expect(resolveProfileAddressLine('Tegeta')).toBe('Tegeta');
    expect(resolveProfileAddressLine('  12 Hub Road  ')).toBe('12 Hub Road');
  });
});

describe('OnboardingService.updateProfile street', () => {
  const user: AuthUser = {
    sub: 'user-1',
    email: 'amina@example.com',
    name: 'Amina',
    role: UserRole.CUSTOMER,
  };
  const progress = {
    startedAt: null,
    completedAt: null,
    checklistDismissed: false,
    completedKeys: [],
    skippedKeys: [],
    activityFlags: {},
  };
  const prisma = {
    user: {
      update: jest.fn(),
      findUnique: jest.fn(),
    },
    onboardingProgress: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    order: { count: jest.fn() },
  };
  const mixpanel = { track: jest.fn() };
  const service = new OnboardingService(prisma as never, mixpanel as never);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.update.mockResolvedValue({});
    prisma.user.findUnique.mockResolvedValue({ profileComplete: false });
    prisma.onboardingProgress.upsert.mockResolvedValue(progress);
    prisma.onboardingProgress.findUnique.mockResolvedValue(progress);
    prisma.onboardingProgress.update.mockResolvedValue(progress);
    prisma.order.count.mockResolvedValue(0);
    mixpanel.track.mockResolvedValue(undefined);
  });

  it('writes a whitespace-only street as null', async () => {
    await service.updateProfile(user, {
      name: '  Amina  ',
      phone: '  +255700000000  ',
      city: '  Dar es Salaam  ',
      addressLine: '   ',
    });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: {
        name: 'Amina',
        phone: '+255700000000',
        city: 'Dar es Salaam',
        addressLine: null,
        profileComplete: true,
      },
    });
  });

  it('trims and preserves an explicitly supplied street', async () => {
    await service.updateProfile(user, {
      name: 'Amina',
      phone: '+255700000000',
      city: 'Dar es Salaam',
      addressLine: '  Tegeta  ',
    });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: {
        name: 'Amina',
        phone: '+255700000000',
        city: 'Dar es Salaam',
        addressLine: 'Tegeta',
        profileComplete: true,
      },
    });
  });

  it.each(['', '   ', '\t\n', undefined])(
    'rejects a missing or blank city (%p) before writing the profile',
    async (city) => {
      await expect(
        service.updateProfile(user, {
          name: 'Amina',
          phone: '+255700000000',
          city,
          addressLine: 'Tegeta',
        }),
      ).rejects.toThrow(
        new BadRequestException('name, phone, and city are required'),
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: '   ', phone: '+255700000000' },
    { name: 'Amina', phone: '' },
  ])(
    'still rejects a missing name or phone before writing the profile',
    async (body) => {
      await expect(
        service.updateProfile(user, {
          ...body,
          city: 'Dar es Salaam',
          addressLine: 'Tegeta',
        }),
      ).rejects.toThrow(
        new BadRequestException('name, phone, and city are required'),
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    },
  );
});
