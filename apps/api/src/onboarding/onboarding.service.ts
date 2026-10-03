import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { OrderStatus, Prisma, UserRole } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { MixpanelService } from '../analytics/mixpanel.service';
import { PrismaService } from '../prisma/prisma.service';
import { OnboardingTaskDef, tasksForRole } from './onboarding.tasks';

type Flags = Record<string, boolean>;

@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mixpanel: MixpanelService,
  ) {}

  async getProgress(user: AuthUser) {
    const progress = await this.ensureProgress(user);
    const defs = tasksForRole(user.role);
    const completed = asStringArray(progress.completedKeys);
    const skipped = asStringArray(progress.skippedKeys);
    const tasks = [];
    for (const def of defs) {
      const verified = await this.isVerified(user, def.key);
      tasks.push({
        ...def,
        completed: completed.includes(def.key),
        skipped: skipped.includes(def.key),
        verified,
        canComplete: verified && !completed.includes(def.key),
      });
    }

    const required = defs.filter((t) => t.required);
    const requiredDone = required.every((t) => completed.includes(t.key));
    const percent = defs.length
      ? Math.round((completed.filter((k) => defs.some((d) => d.key === k)).length / defs.length) * 100)
      : 0;

    return {
      role: user.role,
      startedAt: progress.startedAt?.toISOString() ?? null,
      completedAt: progress.completedAt?.toISOString() ?? null,
      checklistDismissed: progress.checklistDismissed,
      isFirstTime: !progress.completedAt,
      requiredComplete: requiredDone,
      percent,
      completedKeys: completed,
      skippedKeys: skipped,
      tasks,
    };
  }

  async start(user: AuthUser) {
    const progress = await this.ensureProgress(user);
    if (!progress.startedAt) {
      await this.prisma.onboardingProgress.update({
        where: { userId: user.sub },
        data: { startedAt: new Date(), checklistDismissed: false },
      });
      await this.mixpanel.track('onboarding_started', user.sub, {
        role: user.role,
      });
    }
    return this.getProgress(user);
  }

  async dismiss(user: AuthUser) {
    await this.ensureProgress(user);
    await this.prisma.onboardingProgress.update({
      where: { userId: user.sub },
      data: { checklistDismissed: true },
    });
    return this.getProgress(user);
  }

  async resume(user: AuthUser) {
    await this.ensureProgress(user);
    await this.prisma.onboardingProgress.update({
      where: { userId: user.sub },
      data: { checklistDismissed: false },
    });
    return this.getProgress(user);
  }

  async skipTask(user: AuthUser, taskKey: string) {
    const def = this.requireTask(user.role, taskKey);
    if (def.required) {
      throw new BadRequestException('Required onboarding tasks cannot be skipped');
    }
    const progress = await this.ensureProgress(user);
    const skipped = new Set(asStringArray(progress.skippedKeys));
    skipped.add(taskKey);
    await this.prisma.onboardingProgress.update({
      where: { userId: user.sub },
      data: { skippedKeys: [...skipped] },
    });
    return this.getProgress(user);
  }

  async completeTask(user: AuthUser, taskKey: string) {
    this.requireTask(user.role, taskKey);
    const verified = await this.isVerified(user, taskKey);
    if (!verified) {
      throw new BadRequestException(
        'Task is not complete yet — finish the related action first',
      );
    }

    const progress = await this.ensureProgress(user);
    const completed = new Set(asStringArray(progress.completedKeys));
    const already = completed.has(taskKey);
    completed.add(taskKey);

    const defs = tasksForRole(user.role);
    const requiredDone = defs
      .filter((t) => t.required)
      .every((t) => completed.has(t.key));

    await this.prisma.onboardingProgress.update({
      where: { userId: user.sub },
      data: {
        completedKeys: [...completed],
        startedAt: progress.startedAt ?? new Date(),
        completedAt: requiredDone ? progress.completedAt ?? new Date() : null,
        checklistDismissed: requiredDone ? true : progress.checklistDismissed,
      },
    });

    if (!already) {
      await this.mixpanel.track('onboarding_step_completed', user.sub, {
        role: user.role,
        task_key: taskKey,
      });
    }
    if (requiredDone && !progress.completedAt) {
      await this.mixpanel.track('onboarding_completed', user.sub, {
        role: user.role,
      });
    }

    return this.getProgress(user);
  }

  async stampActivity(user: AuthUser, flag: string) {
    const allowed = new Set([
      'browsed_catalog',
      'compared_products',
      'added_to_cart',
      'viewed_orders',
      'received_inventory',
      'viewed_catalogue_admin',
    ]);
    if (!allowed.has(flag)) {
      throw new BadRequestException('Unknown activity flag');
    }
    const progress = await this.ensureProgress(user);
    const flags = asFlags(progress.activityFlags);
    flags[flag] = true;
    await this.prisma.onboardingProgress.update({
      where: { userId: user.sub },
      data: { activityFlags: flags },
    });

    await this.mixpanel.track('first_meaningful_action', user.sub, {
      role: user.role,
      action: flag,
    });

    // Auto-complete when verification now passes.
    const autoMap: Record<string, string> = {
      browsed_catalog: 'customer.discovery',
      compared_products: 'customer.compare',
      added_to_cart: 'customer.cart',
      viewed_orders: 'customer.tracking',
      received_inventory: 'supplier.inventory',
      viewed_catalogue_admin: 'admin.catalogue',
    };
    const taskKey = autoMap[flag];
    if (taskKey && tasksForRole(user.role).some((t) => t.key === taskKey)) {
      try {
        await this.completeTask(user, taskKey);
      } catch {
        // not verified yet / wrong role
      }
    }

    return this.getProgress(user);
  }

  async updateProfile(
    user: AuthUser,
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
    const addressLine = body.addressLine?.trim() || 'Westlands';
    if (!name || !phone || !city) {
      throw new BadRequestException('name, phone, and city are required');
    }
    await this.prisma.user.update({
      where: { id: user.sub },
      data: { name, phone, city, addressLine, profileComplete: true },
    });
    await this.mixpanel.track('first_meaningful_action', user.sub, {
      role: user.role,
      action: 'profile_saved',
    });
    try {
      await this.completeTask(user, 'customer.profile');
    } catch {
      /* role mismatch */
    }
    return this.getProgress(user);
  }

  async updatePreferences(user: AuthUser, body: { locale?: string }) {
    const locale = body.locale?.trim();
    if (!locale || !['en', 'es', 'sw'].includes(locale)) {
      throw new BadRequestException('locale must be en, es, or sw');
    }
    await this.prisma.user.update({
      where: { id: user.sub },
      data: { preferredLocale: locale },
    });
    try {
      await this.completeTask(user, 'customer.preferences');
    } catch {
      /* ignore */
    }
    return this.getProgress(user);
  }

  async updateSupplierBusiness(
    user: AuthUser,
    body: { businessBio?: string; name?: string },
  ) {
    this.assertSupplier(user);
    const bio = body.businessBio?.trim();
    if (!bio) throw new BadRequestException('businessBio is required');
    await this.prisma.supplier.update({
      where: { id: user.supplierId! },
      data: {
        businessBio: bio,
        ...(body.name?.trim() ? { name: body.name.trim() } : {}),
      },
    });
    await this.completeTask(user, 'supplier.business');
    return this.getProgress(user);
  }

  async submitSupplierVerification(user: AuthUser) {
    this.assertSupplier(user);
    await this.prisma.supplier.update({
      where: { id: user.supplierId! },
      data: { verificationStatus: 'SUBMITTED' },
    });
    await this.completeTask(user, 'supplier.verification');
    return this.getProgress(user);
  }

  async setupSupplierPayout(user: AuthUser) {
    this.assertSupplier(user);
    await this.prisma.supplier.update({
      where: { id: user.supplierId! },
      data: { payoutSetupComplete: true },
    });
    await this.completeTask(user, 'supplier.payout');
    return this.getProgress(user);
  }

  async setupSupplierDelivery(user: AuthUser, body: { notes?: string }) {
    this.assertSupplier(user);
    await this.prisma.supplier.update({
      where: { id: user.supplierId! },
      data: {
        deliveryNotes: body.notes?.trim() || 'Standard + Express + Pickup',
        deliveryConfigured: true,
      },
    });
    await this.completeTask(user, 'supplier.delivery');
    return this.getProgress(user);
  }

  async updatePlatform(
    user: AuthUser,
    body: {
      setupComplete?: boolean;
      permissionsSeeded?: boolean;
      deliveryConfigured?: boolean;
      paymentsConfigured?: boolean;
      commissionsConfigured?: boolean;
      currency?: string;
      timezone?: string;
    },
  ) {
    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Admin only');
    }
    await this.prisma.platformSettings.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        currency: body.currency ?? 'USD',
        timezone: body.timezone ?? 'Africa/Nairobi',
        setupComplete: !!body.setupComplete,
        permissionsSeeded: !!body.permissionsSeeded,
        deliveryConfigured: !!body.deliveryConfigured,
        paymentsConfigured: !!body.paymentsConfigured,
        commissionsConfigured: !!body.commissionsConfigured,
      },
      update: {
        ...(body.currency ? { currency: body.currency } : {}),
        ...(body.timezone ? { timezone: body.timezone } : {}),
        ...(body.setupComplete !== undefined
          ? { setupComplete: body.setupComplete }
          : {}),
        ...(body.permissionsSeeded !== undefined
          ? { permissionsSeeded: body.permissionsSeeded }
          : {}),
        ...(body.deliveryConfigured !== undefined
          ? { deliveryConfigured: body.deliveryConfigured }
          : {}),
        ...(body.paymentsConfigured !== undefined
          ? { paymentsConfigured: body.paymentsConfigured }
          : {}),
        ...(body.commissionsConfigured !== undefined
          ? { commissionsConfigured: body.commissionsConfigured }
          : {}),
      },
    });

    const map: Array<[keyof typeof body, string]> = [
      ['setupComplete', 'admin.platform'],
      ['permissionsSeeded', 'admin.permissions'],
      ['deliveryConfigured', 'admin.delivery'],
      ['paymentsConfigured', 'admin.payments'],
      ['commissionsConfigured', 'admin.commissions'],
    ];
    for (const [flag, task] of map) {
      if (body[flag] === true) {
        try {
          await this.completeTask(user, task);
        } catch {
          /* verify failed */
        }
      }
    }
    return this.getProgress(user);
  }

  async approveSupplier(user: AuthUser, supplierId: string) {
    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Admin only');
    }
    await this.prisma.supplier.update({
      where: { id: supplierId },
      data: { verificationStatus: 'APPROVED' },
    });
    try {
      await this.completeTask(user, 'admin.supplierApprovals');
    } catch {
      /* ignore */
    }
    return this.getProgress(user);
  }

  /** Called after successful order create to mark checkout/cart. */
  async onOrderPlaced(userId: string, role: UserRole) {
    if (role !== UserRole.CUSTOMER) return;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return;
    const auth: AuthUser = {
      sub: user.id,
      email: user.email,
      role: user.role,
      supplierId: user.supplierId,
      name: user.name,
    };
    await this.ensureProgress(auth);
    const progress = await this.prisma.onboardingProgress.findUnique({
      where: { userId },
    });
    const flags = asFlags(progress?.activityFlags);
    flags.added_to_cart = true;
    await this.prisma.onboardingProgress.update({
      where: { userId },
      data: { activityFlags: flags },
    });
    for (const key of ['customer.cart', 'customer.checkout', 'customer.tracking']) {
      try {
        await this.completeTask(auth, key);
      } catch {
        /* not ready */
      }
    }
  }

  /** After supplier ships an item. */
  async onSupplierShipped(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.role !== UserRole.SUPPLIER) return;
    const auth: AuthUser = {
      sub: user.id,
      email: user.email,
      role: user.role,
      supplierId: user.supplierId,
      name: user.name,
    };
    try {
      await this.completeTask(auth, 'supplier.fulfillment');
    } catch {
      /* ignore */
    }
  }

  private async isVerified(user: AuthUser, taskKey: string): Promise<boolean> {
    const progress = await this.prisma.onboardingProgress.findUnique({
      where: { userId: user.sub },
    });
    const flags = asFlags(progress?.activityFlags);

    switch (taskKey) {
      case 'customer.profile': {
        const u = await this.prisma.user.findUnique({ where: { id: user.sub } });
        return !!u?.profileComplete;
      }
      case 'customer.preferences': {
        const u = await this.prisma.user.findUnique({ where: { id: user.sub } });
        return !!u?.preferredLocale;
      }
      case 'customer.discovery':
        return !!flags.browsed_catalog;
      case 'customer.compare':
        return !!flags.compared_products;
      case 'customer.cart':
        return !!flags.added_to_cart || (await this.customerOrderCount(user.sub)) > 0;
      case 'customer.checkout':
      case 'customer.tracking':
        return (await this.customerOrderCount(user.sub)) > 0;
      case 'supplier.business': {
        const s = await this.supplier(user);
        return !!s?.businessBio;
      }
      case 'supplier.verification': {
        const s = await this.supplier(user);
        return (
          s?.verificationStatus === 'SUBMITTED' ||
          s?.verificationStatus === 'APPROVED'
        );
      }
      case 'supplier.payout': {
        const s = await this.supplier(user);
        return !!s?.payoutSetupComplete;
      }
      case 'supplier.listing': {
        if (!user.supplierId) return false;
        const count = await this.prisma.product.count({
          where: { supplierId: user.supplierId },
        });
        return count > 0;
      }
      case 'supplier.inventory': {
        if (!user.supplierId) return false;
        if (flags.received_inventory) return true;
        const ledger = await this.prisma.inventoryLedger.count({
          where: { supplierId: user.supplierId },
        });
        return ledger > 0;
      }
      case 'supplier.delivery': {
        const s = await this.supplier(user);
        return !!s?.deliveryConfigured;
      }
      case 'supplier.fulfillment': {
        if (!user.supplierId) return false;
        const shipped = await this.prisma.orderItem.count({
          where: {
            supplierId: user.supplierId,
            status: { in: [OrderStatus.SHIPPED, OrderStatus.DELIVERED] },
          },
        });
        return shipped > 0;
      }
      case 'admin.platform':
        return !!(await this.platform())?.setupComplete;
      case 'admin.permissions':
        return !!(await this.platform())?.permissionsSeeded;
      case 'admin.supplierApprovals': {
        const approved = await this.prisma.supplier.count({
          where: { verificationStatus: 'APPROVED' },
        });
        return approved > 0;
      }
      case 'admin.catalogue': {
        const products = await this.prisma.product.count();
        return products > 0 || !!flags.viewed_catalogue_admin;
      }
      case 'admin.orderOps': {
        const orders = await this.prisma.order.count();
        return orders > 0;
      }
      case 'admin.delivery':
        return !!(await this.platform())?.deliveryConfigured;
      case 'admin.payments':
        return !!(await this.platform())?.paymentsConfigured;
      case 'admin.commissions':
        return !!(await this.platform())?.commissionsConfigured;
      default:
        return false;
    }
  }

  private async customerOrderCount(userId: string) {
    return this.prisma.order.count({ where: { customerId: userId } });
  }

  private async supplier(user: AuthUser) {
    if (!user.supplierId) return null;
    return this.prisma.supplier.findUnique({ where: { id: user.supplierId } });
  }

  private async platform() {
    return this.prisma.platformSettings.findUnique({ where: { id: 'default' } });
  }

  private assertSupplier(user: AuthUser) {
    if (user.role !== UserRole.SUPPLIER || !user.supplierId) {
      throw new ForbiddenException('Supplier only');
    }
  }

  private requireTask(role: UserRole, taskKey: string): OnboardingTaskDef {
    const def = tasksForRole(role).find((t) => t.key === taskKey);
    if (!def) throw new BadRequestException('Unknown task for role');
    return def;
  }

  private async ensureProgress(user: AuthUser) {
    return this.prisma.onboardingProgress.upsert({
      where: { userId: user.sub },
      create: {
        userId: user.sub,
        role: user.role,
        completedKeys: [],
        skippedKeys: [],
        activityFlags: {},
      },
      update: { role: user.role },
    });
  }
}

function asStringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function asFlags(value: Prisma.JsonValue | undefined): Flags {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Flags = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}
