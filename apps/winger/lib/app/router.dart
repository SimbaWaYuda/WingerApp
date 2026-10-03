import 'package:go_router/go_router.dart';

import '../core/models/models.dart';
import '../core/state/app_session.dart';
import '../features/admin/admin_screens.dart';
import '../features/auth/login_screen.dart';
import '../features/auth/signup_screen.dart';
import '../features/customer/customer_screens.dart';
import '../features/onboarding/onboarding_screens.dart';
import '../features/supplier/supplier_screens.dart';

GoRouter createRouter(AppSession session) {
  return GoRouter(
    initialLocation: '/login',
    refreshListenable: session,
    redirect: (context, state) {
      final loc = state.matchedLocation;
      final onAuth = loc == '/login' || loc == '/signup';
      if (!session.isSignedIn && !onAuth) return '/login';
      if (session.isSignedIn && onAuth) {
        return switch (session.role!) {
          UserRole.customer => '/customer',
          UserRole.supplier => '/supplier',
          UserRole.admin => '/admin',
        };
      }
      if (session.role == UserRole.customer &&
          (loc.startsWith('/supplier') || loc.startsWith('/admin'))) {
        return '/customer';
      }
      if (session.role == UserRole.supplier &&
          (loc.startsWith('/customer') || loc.startsWith('/admin'))) {
        return '/supplier';
      }
      if (session.role == UserRole.admin &&
          (loc.startsWith('/customer') || loc.startsWith('/supplier'))) {
        return '/admin';
      }
      return null;
    },
    routes: [
      GoRoute(path: '/login', builder: (context, state) => const LoginScreen()),
      GoRoute(path: '/signup', builder: (context, state) => const SignupScreen()),
      ShellRoute(
        builder: (context, state, child) => CustomerShell(child: child),
        routes: [
          GoRoute(path: '/customer', builder: (context, state) => const CustomerHomeScreen()),
          GoRoute(path: '/customer/onboarding', builder: (context, state) => const CustomerOnboardingScreen()),
          GoRoute(path: '/customer/search', builder: (context, state) => const CustomerSearchScreen()),
          GoRoute(path: '/customer/compare', builder: (context, state) => const CompareScreen()),
          GoRoute(
            path: '/customer/product/:id',
            builder: (context, state) =>
                ProductDetailScreen(productId: state.pathParameters['id']!),
          ),
          GoRoute(path: '/customer/cart', builder: (context, state) => const CartScreen()),
          GoRoute(path: '/customer/checkout', builder: (context, state) => const CheckoutScreen()),
          GoRoute(path: '/customer/orders', builder: (context, state) => const OrdersScreen()),
          GoRoute(path: '/customer/account', builder: (context, state) => const CustomerAccountScreen()),
        ],
      ),
      ShellRoute(
        builder: (context, state, child) => SupplierShell(child: child),
        routes: [
          GoRoute(path: '/supplier', builder: (context, state) => const SupplierDashboardScreen()),
          GoRoute(path: '/supplier/onboarding', builder: (context, state) => const SupplierOnboardingScreen()),
          GoRoute(path: '/supplier/orders', builder: (context, state) => const SupplierOrdersScreen()),
          GoRoute(path: '/supplier/products', builder: (context, state) => const SupplierProductsScreen()),
          GoRoute(path: '/supplier/payments', builder: (context, state) => const SupplierPaymentsScreen()),
        ],
      ),
      ShellRoute(
        builder: (context, state, child) => AdminShell(child: child),
        routes: [
          GoRoute(path: '/admin', builder: (context, state) => const AdminDashboardScreen()),
          GoRoute(path: '/admin/onboarding', builder: (context, state) => const AdminOnboardingScreen()),
          GoRoute(path: '/admin/suppliers', builder: (context, state) => const AdminSuppliersScreen()),
          GoRoute(path: '/admin/orders', builder: (context, state) => const AdminOrdersScreen()),
          GoRoute(path: '/admin/delivery', builder: (context, state) => const AdminDeliveryScreen()),
        ],
      ),
    ],
  );
}
