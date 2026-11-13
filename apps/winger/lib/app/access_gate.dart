import '../core/models/models.dart';

class AccessDecision {
  const AccessDecision({
    this.location,
    required this.resumeCheckout,
    this.authPrompt,
  });

  final String? location;
  final bool resumeCheckout;
  final String? authPrompt;
}

bool isPublicCustomerShop(String location) {
  return location == '/customer' ||
      location == '/customer/search' ||
      location.startsWith('/customer/search/') ||
      location.startsWith('/customer/product/') ||
      location == '/customer/cart' ||
      location == '/customer/compare' ||
      location == '/customer/recent';
}

String homeForRole(UserRole? role) {
  return switch (role) {
    UserRole.customer => '/customer',
    UserRole.supplier => '/supplier',
    UserRole.admin => '/admin',
    null => '/login',
  };
}

AccessDecision customerAccessGate({
  required bool signedIn,
  required bool guest,
  required bool mustChangePassword,
  required UserRole? role,
  required bool? supplierApproved,
  required bool resumeCheckout,
  required String location,
  String? authPrompt,
}) {
  final onAuth = location == '/login' ||
      location == '/signup' ||
      location == '/continue-purchase';
  if (!signedIn) {
    if (onAuth) {
      return AccessDecision(
        resumeCheckout: resumeCheckout,
        authPrompt: authPrompt,
      );
    }
    if (guest && isPublicCustomerShop(location)) {
      return AccessDecision(
        resumeCheckout: resumeCheckout,
        authPrompt: authPrompt,
      );
    }
    if (guest && location.startsWith('/customer')) {
      final checkout = location.startsWith('/customer/checkout');
      return AccessDecision(
        location: checkout ? '/continue-purchase' : '/login',
        resumeCheckout: checkout,
        authPrompt: checkout ? 'checkout' : 'account',
      );
    }
    if (guest) {
      return AccessDecision(
        location: '/customer',
        resumeCheckout: resumeCheckout,
        authPrompt: authPrompt,
      );
    }
    return AccessDecision(
      location: '/login',
      resumeCheckout: resumeCheckout,
      authPrompt: authPrompt,
    );
  }

  if (mustChangePassword) {
    return AccessDecision(
      location: location == '/choose-password' ? null : '/choose-password',
      resumeCheckout: resumeCheckout,
      authPrompt: authPrompt,
    );
  }

  if (onAuth || location == '/choose-password') {
    final next = _signedInLanding(
      role: role,
      supplierApproved: supplierApproved,
      resumeCheckout: resumeCheckout,
    );
    return AccessDecision(
      location: next,
      // Keep the flag until the cart route is open. Clearing it here lets a
      // second redirect, still on the login page, send the shopper home.
      resumeCheckout: next == '/customer/cart',
      authPrompt: null,
    );
  }

  if (location == '/customer/cart' && resumeCheckout) {
    return AccessDecision(
      resumeCheckout: false,
      authPrompt: null,
    );
  }

  if (role == UserRole.supplier &&
      supplierApproved == false &&
      location.startsWith('/supplier') &&
      location != '/supplier/onboarding') {
    return AccessDecision(
      location: '/supplier/onboarding',
      resumeCheckout: false,
      authPrompt: null,
    );
  }

  if (role == UserRole.customer &&
      (location.startsWith('/supplier') || location.startsWith('/admin'))) {
    return AccessDecision(
      location: '/customer',
      resumeCheckout: resumeCheckout,
      authPrompt: null,
    );
  }
  if (role == UserRole.supplier &&
      (location.startsWith('/customer') || location.startsWith('/admin'))) {
    return AccessDecision(
      location: supplierApproved == false
          ? '/supplier/onboarding'
          : '/supplier',
      resumeCheckout: false,
      authPrompt: null,
    );
  }
  if (role == UserRole.admin &&
      (location.startsWith('/customer') || location.startsWith('/supplier'))) {
    return AccessDecision(
      location: '/admin',
      resumeCheckout: false,
      authPrompt: null,
    );
  }

  return AccessDecision(
    resumeCheckout: resumeCheckout,
    authPrompt: authPrompt,
  );
}

String _signedInLanding({
  required UserRole? role,
  required bool? supplierApproved,
  required bool resumeCheckout,
}) {
  if (role == UserRole.supplier && supplierApproved == false) {
    return '/supplier/onboarding';
  }
  if (role == UserRole.customer && resumeCheckout) {
    return '/customer/cart';
  }
  return homeForRole(role);
}
