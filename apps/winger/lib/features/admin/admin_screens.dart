import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/data/mock_catalog.dart';
import '../../core/l10n/winger_strings.dart';
import '../../core/models/models.dart';
import '../../core/state/app_session.dart';
import '../../core/theme/winger_colors.dart';
import '../../core/widgets/kpi_card.dart';
import '../../core/widgets/role_shell.dart';
import '../../core/widgets/status_badge.dart';
import '../onboarding/onboarding_checklist.dart';

const adminDestinations = [
  ShellDestination(labelKey: 'dashboard', icon: Icons.dashboard_outlined, path: '/admin'),
  ShellDestination(labelKey: 'suppliers', icon: Icons.storefront_outlined, path: '/admin/suppliers'),
  ShellDestination(labelKey: 'orders', icon: Icons.receipt_long_outlined, path: '/admin/orders'),
  ShellDestination(labelKey: 'delivery', icon: Icons.local_shipping_outlined, path: '/admin/delivery'),
];

class AdminShell extends StatelessWidget {
  const AdminShell({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    return RoleShell(
      title: s.t('dashboard'),
      roleLabel: 'Administrator',
      destinations: adminDestinations,
      child: child,
    );
  }
}

class AdminDashboardScreen extends StatelessWidget {
  const AdminDashboardScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final wide = MediaQuery.sizeOf(context).width >= 900;

    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const OnboardingChecklistCard(journeyRoute: '/admin/onboarding'),
        Text(s.t('dashboard'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
        const SizedBox(height: 16),
        GridView.count(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          crossAxisCount: wide ? 4 : 2,
          mainAxisSpacing: 12,
          crossAxisSpacing: 12,
          childAspectRatio: wide ? 1.4 : 1.25,
          children: [for (final kpi in MockCatalog.adminKpis) KpiCard(data: kpi)],
        ),
        const SizedBox(height: 20),
        Text(s.t('operationalQueue'), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
        const SizedBox(height: 8),
        for (final item in const [
          ('Supplier reviews', '12'),
          ('Delivery exceptions', '17'),
          ('Payment holds', '5'),
          ('Catalogue approvals', '9'),
        ])
          Card(
            child: ListTile(
              title: Text(item.$1),
              trailing: CircleAvatar(
                radius: 16,
                backgroundColor: WingerColors.brandMuted,
                child: Text(item.$2, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w800)),
              ),
            ),
          ),
        const SizedBox(height: 12),
        Text(s.t('platformAlerts'), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
        const Card(
          child: ListTile(
            title: Text('Delivery · Late hub transfer'),
            subtitle: Text('Owner: Ops · SLA at risk'),
            trailing: Text('HIGH', style: TextStyle(color: WingerColors.dangerInk, fontWeight: FontWeight.w800)),
          ),
        ),
      ],
    );
  }
}

class AdminSuppliersScreen extends StatelessWidget {
  const AdminSuppliersScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    const suppliers = [
      ('Kijani Tech', '286 orders', 'LIVE'),
      ('Atlas Home', '142 orders', 'LIVE'),
      ('Metals Outdoor', '98 orders', 'REVIEW'),
    ];
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text(s.t('suppliers'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
        const SizedBox(height: 12),
        for (final supplier in suppliers)
          Card(
            child: ListTile(
              title: Text(supplier.$1, style: const TextStyle(fontWeight: FontWeight.w700)),
              subtitle: Text(supplier.$2),
              trailing: Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: supplier.$3 == 'LIVE' ? WingerColors.success : WingerColors.info,
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Text(
                  supplier.$3,
                  style: TextStyle(
                    fontWeight: FontWeight.w800,
                    fontSize: 12,
                    color: supplier.$3 == 'LIVE' ? WingerColors.successInk : WingerColors.infoInk,
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class AdminOrdersScreen extends StatefulWidget {
  const AdminOrdersScreen({super.key});

  @override
  State<AdminOrdersScreen> createState() => _AdminOrdersScreenState();
}

class _AdminOrdersScreenState extends State<AdminOrdersScreen> {
  Future<List<CustomerOrder>>? _future;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _future ??= _load();
  }

  Future<List<CustomerOrder>> _load() async {
    final session = context.read<AppSession>();
    final api = context.read<ApiClient>();
    if (session.apiOnline && session.accessToken != null) {
      return api.fetchOrders();
    }
    return [];
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final future = _future;
    if (future == null) {
      return const Center(child: CircularProgressIndicator());
    }

    return FutureBuilder<List<CustomerOrder>>(
      future: future,
      builder: (context, snapshot) {
        final orders = snapshot.data ?? [];
        return ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Text(s.t('orders'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: 12),
            if (snapshot.connectionState != ConnectionState.done)
              const Center(child: CircularProgressIndicator())
            else if (orders.isEmpty)
              Text('No orders in the platform yet.', style: TextStyle(color: WingerColors.muted))
            else
              for (final order in orders)
                Card(
                  child: ListTile(
                    title: Text(order.id, style: const TextStyle(fontWeight: FontWeight.w700)),
                    subtitle: Text(
                      '${order.customerName} · ${order.itemRows.length} line(s) · ${order.paymentStatus}',
                    ),
                    trailing: StatusBadge(status: order.status),
                  ),
                ),
          ],
        );
      },
    );
  }
}

class AdminDeliveryScreen extends StatelessWidget {
  const AdminDeliveryScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final order = MockCatalog.sampleOrder;
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text(s.t('delivery'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
        const SizedBox(height: 12),
        Wrap(
          spacing: 12,
          runSpacing: 12,
          children: const [
            SizedBox(width: 160, child: KpiCard(data: KpiCardData(label: 'In transit', value: '1,284', delta: '+2.1%'))),
            SizedBox(width: 160, child: KpiCard(data: KpiCardData(label: 'Pickup ready', value: '218', delta: '+1.0%'))),
            SizedBox(
              width: 160,
              child: KpiCard(data: KpiCardData(label: 'Exceptions', value: '17', delta: 'attention', positive: false)),
            ),
          ],
        ),
        const SizedBox(height: 16),
        Text('Split shipment: ${order.id}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
        const SizedBox(height: 8),
        for (final leg in order.shipments)
          Card(
            child: ListTile(
              title: Text(leg.supplierName, style: const TextStyle(fontWeight: FontWeight.w700)),
              subtitle: Text(leg.productName),
              trailing: StatusBadge(status: leg.status),
            ),
          ),
      ],
    );
  }
}
