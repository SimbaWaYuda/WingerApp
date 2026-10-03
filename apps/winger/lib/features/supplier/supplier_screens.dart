import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/data/mock_catalog.dart';
import '../../core/l10n/winger_strings.dart';
import '../../core/models/models.dart';
import '../../core/offline/sync_engine.dart';
import '../../core/repositories/inventory_repository.dart';
import '../../core/state/app_session.dart';
import '../../core/theme/winger_colors.dart';
import '../../core/widgets/kpi_card.dart';
import '../../core/widgets/role_shell.dart';
import '../../core/widgets/status_badge.dart';
import '../onboarding/onboarding_checklist.dart';

const supplierDestinations = [
  ShellDestination(labelKey: 'overview', icon: Icons.dashboard_outlined, path: '/supplier'),
  ShellDestination(labelKey: 'orders', icon: Icons.receipt_long_outlined, path: '/supplier/orders'),
  ShellDestination(labelKey: 'products', icon: Icons.inventory_2_outlined, path: '/supplier/products'),
  ShellDestination(labelKey: 'payments', icon: Icons.payments_outlined, path: '/supplier/payments'),
];

class SupplierShell extends StatelessWidget {
  const SupplierShell({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    return RoleShell(
      title: s.t('dashboard'),
      roleLabel: 'Supplier',
      destinations: supplierDestinations,
      child: child,
    );
  }
}

class SupplierDashboardScreen extends StatelessWidget {
  const SupplierDashboardScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final wide = MediaQuery.sizeOf(context).width >= 900;

    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const OnboardingChecklistCard(journeyRoute: '/supplier/onboarding'),
        Text(s.t('overview'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
        const SizedBox(height: 16),
        GridView.count(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          crossAxisCount: wide ? 4 : 2,
          mainAxisSpacing: 12,
          crossAxisSpacing: 12,
          childAspectRatio: wide ? 1.4 : 1.25,
          children: [for (final kpi in MockCatalog.supplierKpis) KpiCard(data: kpi)],
        ),
        const SizedBox(height: 20),
        Text(s.t('orders'), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
        const SizedBox(height: 8),
        const Text(
          'Open Orders for live supplier lines from the API.',
          style: TextStyle(color: WingerColors.muted),
        ),
      ],
    );
  }
}

class SupplierOrdersScreen extends StatefulWidget {
  const SupplierOrdersScreen({super.key});

  @override
  State<SupplierOrdersScreen> createState() => _SupplierOrdersScreenState();
}

class _SupplierOrdersScreenState extends State<SupplierOrdersScreen> {
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

  Future<void> _markShipped(CustomerOrder order, OrderItemRow item) async {
    final api = context.read<ApiClient>();
    try {
      await api.updateOrderItemStatus(
        orderId: order.id,
        itemId: item.id,
        status: OrderStatus.shipped,
        trackingCode: 'TRK-${item.productId.toUpperCase()}',
      );
      if (!mounted) return;
      final next = _load();
      setState(() {
        _future = next;
      });
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not mark shipped: $error')),
      );
    }
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
              const Padding(
                padding: EdgeInsets.only(top: 24),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (orders.isEmpty)
              Text('No paid orders for your catalogue yet.', style: TextStyle(color: WingerColors.muted))
            else
              for (final order in orders)
                for (final item in order.itemRows)
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Text(order.id, style: const TextStyle(fontWeight: FontWeight.w800)),
                              const Spacer(),
                              StatusBadge(status: item.status),
                            ],
                          ),
                          const SizedBox(height: 8),
                          Text(order.customerName),
                          Text('${item.productName} × ${item.quantity}'),
                          Text('\$${item.lineTotal.toStringAsFixed(2)}'),
                          const SizedBox(height: 12),
                          Wrap(
                            spacing: 8,
                            children: [
                              OutlinedButton(onPressed: () {}, child: Text(s.t('fulfillment'))),
                              FilledButton(
                                onPressed: item.status == OrderStatus.shipped ||
                                        item.status == OrderStatus.delivered
                                    ? null
                                    : () => _markShipped(order, item),
                                child: const Text('Mark shipped'),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
          ],
        );
      },
    );
  }
}

class SupplierProductsScreen extends StatefulWidget {
  const SupplierProductsScreen({super.key});

  @override
  State<SupplierProductsScreen> createState() => _SupplierProductsScreenState();
}

class _SupplierProductsScreenState extends State<SupplierProductsScreen> {
  Future<List<({String productId, String name, String supplierId, int quantity})>>? _future;

  String get _supplierId =>
      context.read<AppSession>().supplierId ?? 's-kijani';

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _future ??= context.read<InventoryRepository>().listForSupplier(_supplierId);
  }

  void _reload() {
    _future = context.read<InventoryRepository>().listForSupplier(_supplierId);
  }

  Future<void> _receive(String productId, String name) async {
    final inventory = context.read<InventoryRepository>();
    final session = context.read<AppSession>();
    final sync = context.read<SyncEngine>();
    final next = await inventory.receiveStock(
      productId: productId,
      supplierId: _supplierId,
      quantity: 20,
      userId: session.userId,
    );
    await sync.flush();
    if (!mounted) return;
    setState(_reload);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          session.apiOnline
              ? 'Received +20 for $name · stock $next · synced'
              : 'Received +20 for $name · stock $next · queued offline',
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final future = _future;
    if (future == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return FutureBuilder(
      future: future,
      builder: (context, snapshot) {
        final rows = snapshot.data ?? [];
        return ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Row(
              children: [
                Text(
                  s.t('products'),
                  style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
                ),
                const Spacer(),
                IconButton(
                  tooltip: 'Refresh stock from API',
                  onPressed: () {
                    final next = context
                        .read<InventoryRepository>()
                        .listForSupplier(_supplierId, refreshFromServer: true);
                    setState(() {
                      _future = next;
                    });
                  },
                  icon: const Icon(Icons.refresh),
                ),
              ],
            ),
            Text(
              'Stock synced from API · offline receive supported',
              style: TextStyle(color: WingerColors.muted, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 12),
            if (snapshot.connectionState != ConnectionState.done)
              const Padding(
                padding: EdgeInsets.only(top: 24),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (rows.isEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 24),
                child: Text(
                  'No products for this supplier yet.',
                  style: TextStyle(color: WingerColors.muted, fontWeight: FontWeight.w600),
                ),
              )
            else
              for (final row in rows)
                Card(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                    child: Row(
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(row.name, style: const TextStyle(fontWeight: FontWeight.w700)),
                              const SizedBox(height: 4),
                              Text(
                                'Stock: ${row.quantity}',
                                style: TextStyle(color: WingerColors.muted),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(width: 12),
                        FilledButton(
                          onPressed: () => _receive(row.productId, row.name),
                          child: const Text('Receive +20'),
                        ),
                      ],
                    ),
                  ),
                ),
          ],
        );
      },
    );
  }
}

class SupplierPaymentsScreen extends StatelessWidget {
  const SupplierPaymentsScreen({super.key});

  static const _paymentKpis = [
    KpiCardData(label: 'Next payout', value: '\$8,412', delta: '3 days'),
    KpiCardData(label: 'Pending', value: '\$1,204', delta: 'held'),
    KpiCardData(label: 'Commissions YTD', value: '\$5,834', delta: '12%'),
    KpiCardData(label: 'Paid this month', value: '\$42,786', delta: '+6.9%'),
  ];

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text(s.t('payments'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
        const SizedBox(height: 16),
        GridView.count(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          crossAxisCount: MediaQuery.sizeOf(context).width >= 900 ? 4 : 2,
          mainAxisSpacing: 12,
          crossAxisSpacing: 12,
          childAspectRatio: 1.3,
          children: [for (final kpi in _paymentKpis) KpiCard(data: kpi)],
        ),
        const SizedBox(height: 16),
        Card(
          child: ListTile(
            title: const Text('Settlement WG-10025'),
            subtitle: Text('${s.t('commission')} 12% · Net \$219.12'),
            trailing: const Text(
              'PAID',
              style: TextStyle(color: WingerColors.successInk, fontWeight: FontWeight.w800),
            ),
          ),
        ),
      ],
    );
  }
}
