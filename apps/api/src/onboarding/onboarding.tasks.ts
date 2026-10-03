import { UserRole } from '@prisma/client';

export type OnboardingTaskDef = {
  key: string;
  required: boolean;
  titleKey: string;
  bodyKey: string;
  route?: string;
};

export const CUSTOMER_TASKS: OnboardingTaskDef[] = [
  {
    key: 'customer.profile',
    required: true,
    titleKey: 'obCustomerProfile',
    bodyKey: 'obCustomerProfileBody',
    route: '/customer/onboarding',
  },
  {
    key: 'customer.preferences',
    required: true,
    titleKey: 'obCustomerPrefs',
    bodyKey: 'obCustomerPrefsBody',
    route: '/customer/onboarding',
  },
  {
    key: 'customer.discovery',
    required: true,
    titleKey: 'obCustomerDiscovery',
    bodyKey: 'obCustomerDiscoveryBody',
    route: '/customer/search',
  },
  {
    key: 'customer.compare',
    required: false,
    titleKey: 'obCustomerCompare',
    bodyKey: 'obCustomerCompareBody',
    route: '/customer/compare',
  },
  {
    key: 'customer.cart',
    required: true,
    titleKey: 'obCustomerCart',
    bodyKey: 'obCustomerCartBody',
    route: '/customer/cart',
  },
  {
    key: 'customer.checkout',
    required: true,
    titleKey: 'obCustomerCheckout',
    bodyKey: 'obCustomerCheckoutBody',
    route: '/customer/checkout',
  },
  {
    key: 'customer.tracking',
    required: true,
    titleKey: 'obCustomerTracking',
    bodyKey: 'obCustomerTrackingBody',
    route: '/customer/orders',
  },
];

export const SUPPLIER_TASKS: OnboardingTaskDef[] = [
  {
    key: 'supplier.business',
    required: true,
    titleKey: 'obSupplierBusiness',
    bodyKey: 'obSupplierBusinessBody',
    route: '/supplier/onboarding',
  },
  {
    key: 'supplier.verification',
    required: true,
    titleKey: 'obSupplierVerification',
    bodyKey: 'obSupplierVerificationBody',
    route: '/supplier/onboarding',
  },
  {
    key: 'supplier.payout',
    required: true,
    titleKey: 'obSupplierPayout',
    bodyKey: 'obSupplierPayoutBody',
    route: '/supplier/payments',
  },
  {
    key: 'supplier.listing',
    required: true,
    titleKey: 'obSupplierListing',
    bodyKey: 'obSupplierListingBody',
    route: '/supplier/products',
  },
  {
    key: 'supplier.inventory',
    required: true,
    titleKey: 'obSupplierInventory',
    bodyKey: 'obSupplierInventoryBody',
    route: '/supplier/products',
  },
  {
    key: 'supplier.delivery',
    required: true,
    titleKey: 'obSupplierDelivery',
    bodyKey: 'obSupplierDeliveryBody',
    route: '/supplier/onboarding',
  },
  {
    key: 'supplier.fulfillment',
    required: true,
    titleKey: 'obSupplierFulfillment',
    bodyKey: 'obSupplierFulfillmentBody',
    route: '/supplier/orders',
  },
];

export const ADMIN_TASKS: OnboardingTaskDef[] = [
  {
    key: 'admin.platform',
    required: true,
    titleKey: 'obAdminPlatform',
    bodyKey: 'obAdminPlatformBody',
    route: '/admin/onboarding',
  },
  {
    key: 'admin.permissions',
    required: true,
    titleKey: 'obAdminPermissions',
    bodyKey: 'obAdminPermissionsBody',
    route: '/admin/onboarding',
  },
  {
    key: 'admin.supplierApprovals',
    required: true,
    titleKey: 'obAdminApprovals',
    bodyKey: 'obAdminApprovalsBody',
    route: '/admin/suppliers',
  },
  {
    key: 'admin.catalogue',
    required: true,
    titleKey: 'obAdminCatalogue',
    bodyKey: 'obAdminCatalogueBody',
    route: '/admin/onboarding',
  },
  {
    key: 'admin.orderOps',
    required: true,
    titleKey: 'obAdminOrderOps',
    bodyKey: 'obAdminOrderOpsBody',
    route: '/admin/orders',
  },
  {
    key: 'admin.delivery',
    required: true,
    titleKey: 'obAdminDelivery',
    bodyKey: 'obAdminDeliveryBody',
    route: '/admin/delivery',
  },
  {
    key: 'admin.payments',
    required: true,
    titleKey: 'obAdminPayments',
    bodyKey: 'obAdminPaymentsBody',
    route: '/admin/onboarding',
  },
  {
    key: 'admin.commissions',
    required: true,
    titleKey: 'obAdminCommissions',
    bodyKey: 'obAdminCommissionsBody',
    route: '/admin/onboarding',
  },
];

export function tasksForRole(role: UserRole): OnboardingTaskDef[] {
  switch (role) {
    case UserRole.CUSTOMER:
      return CUSTOMER_TASKS;
    case UserRole.SUPPLIER:
      return SUPPLIER_TASKS;
    case UserRole.ADMIN:
      return ADMIN_TASKS;
  }
}
