import 'package:flutter_test/flutter_test.dart';
import 'package:winger/app/access_gate.dart';
import 'package:winger/core/models/models.dart';
import 'package:winger/core/state/app_session.dart';

AccessDecision gate({
  bool signedIn = false,
  bool guest = false,
  bool mustChangePassword = false,
  UserRole? role,
  bool? supplierApproved,
  bool resumeCheckout = false,
  required String location,
  String? authPrompt,
}) {
  return customerAccessGate(
    signedIn: signedIn,
    guest: guest,
    mustChangePassword: mustChangePassword,
    role: role,
    supplierApproved: supplierApproved,
    resumeCheckout: resumeCheckout,
    location: location,
    authPrompt: authPrompt,
  );
}

void main() {
  test('guest can open the shop, search, product, and cart', () {
    for (final path in [
      '/customer',
      '/customer/search',
      '/customer/product/p-1',
      '/customer/cart',
    ]) {
      final decision = gate(guest: true, location: path);
      expect(decision.location, isNull, reason: path);
    }
  });

  test('guest checkout opens the purchase prompt and keeps the cart intent', () {
    final decision = gate(guest: true, location: '/customer/checkout');
    expect(decision.location, '/continue-purchase');
    expect(decision.resumeCheckout, isTrue);
    expect(decision.authPrompt, 'checkout');
    expect(gate(guest: true, location: '/continue-purchase').location, isNull);
  });

  test('guest account pages ask for sign-in without forcing checkout', () {
    final decision = gate(guest: true, location: '/customer/orders');
    expect(decision.location, '/login');
    expect(decision.resumeCheckout, isFalse);
    expect(decision.authPrompt, 'account');
  });

  test('guest cannot open supplier or admin routes', () {
    expect(gate(guest: true, location: '/supplier').location, '/customer');
    expect(gate(guest: true, location: '/admin').location, '/customer');
  });

  test('signed-out visitors stay on the login screen', () {
    expect(gate(location: '/customer').location, '/login');
    expect(gate(location: '/admin').location, '/login');
    expect(gate(location: '/login').location, isNull);
  });

  test('login restores a guest cart by continuing checkout', () {
    for (final path in ['/login', '/signup', '/continue-purchase']) {
      final decision = gate(
        signedIn: true,
        role: UserRole.customer,
        resumeCheckout: true,
        location: path,
      );
      expect(decision.location, '/customer/cart', reason: path);
      expect(decision.resumeCheckout, isTrue, reason: path);
    }
    final arrived = gate(
      signedIn: true,
      role: UserRole.customer,
      resumeCheckout: true,
      location: '/customer/cart',
    );
    expect(arrived.location, isNull);
    expect(arrived.resumeCheckout, isFalse);
  });

  test('pending supplier is kept on onboarding', () {
    expect(
      gate(
        signedIn: true,
        role: UserRole.supplier,
        supplierApproved: false,
        location: '/supplier/products',
      ).location,
      '/supplier/onboarding',
    );
    expect(
      gate(
        signedIn: true,
        role: UserRole.supplier,
        supplierApproved: false,
        location: '/login',
      ).location,
      '/supplier/onboarding',
    );
  });

  test('approved supplier and admin keep their homes', () {
    expect(
      gate(
        signedIn: true,
        role: UserRole.supplier,
        supplierApproved: true,
        location: '/supplier/products',
      ).location,
      isNull,
    );
    expect(
      gate(
        signedIn: true,
        role: UserRole.admin,
        location: '/admin/orders',
      ).location,
      isNull,
    );
    expect(
      gate(
        signedIn: true,
        role: UserRole.customer,
        location: '/admin',
      ).location,
      '/customer',
    );
    expect(
      gate(
        signedIn: true,
        role: UserRole.supplier,
        supplierApproved: true,
        location: '/admin',
      ).location,
      '/supplier',
    );
  });

  test('guest cart remains after registration', () async {
    final session = AppSession();
    session.continueAsGuest();
    const product = Product(
      id: 'p-1',
      name: 'Sandal',
      brand: 'Mossimo',
      supplierId: 's-kijani',
      supplierName: 'Kijani Tech',
      price: 12,
      rating: 4,
      imageUrl: '/uploads/sandal.jpg',
      category: 'Shoes',
    );
    await session.addToCart(product, quantity: 2, variantColor: 'black', variantSize: '39');
    session.applyAuth(
      token: 'token',
      id: 'user-1',
      name: 'Amina',
      mail: 'amina@example.com',
      selectedRole: UserRole.customer,
    );
    expect(session.browsingAsGuest, isFalse);
    expect(session.isSignedIn, isTrue);
    expect(session.cart, hasLength(1));
    expect(session.cart.single.quantity, 2);
    expect(session.cart.single.variantColor, 'black');
  });
}
