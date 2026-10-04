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
  ShellDestination(labelKey: 'returns', icon: Icons.assignment_return_outlined, path: '/supplier/returns'),
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

  void _reload() {
    final next = _load();
    setState(() {
      _future = next;
    });
  }

  /// Unique per order line — never derived from product id alone.
  String _defaultTrackingCode(CustomerOrder order, OrderItemRow item) {
    final orderKey = order.id.replaceAll(RegExp(r'[^A-Za-z0-9]'), '').toUpperCase();
    final itemKey = item.id.replaceAll(RegExp(r'[^A-Za-z0-9]'), '').toUpperCase();
    final shortItem =
        itemKey.length > 6 ? itemKey.substring(itemKey.length - 6) : itemKey;
    return 'TRK-$orderKey-$shortItem';
  }

  String _defaultPickupCode(CustomerOrder order, OrderItemRow item) {
    final digits = order.id.replaceAll(RegExp(r'[^0-9]'), '');
    final orderPart = digits.length >= 4
        ? digits.substring(digits.length - 4)
        : digits.padLeft(4, '0');
    final itemKey = item.id.replaceAll(RegExp(r'[^A-Za-z0-9]'), '').toUpperCase();
    final shortItem =
        itemKey.length > 4 ? itemKey.substring(itemKey.length - 4) : itemKey;
    return 'PU-$orderPart-$shortItem';
  }

  bool _isProductScopedTracking(String? code) {
    if (code == null) return false;
    // Legacy defaults looked like TRK-P-PULSEWATCH (product id only).
    return RegExp(r'^TRK-P-', caseSensitive: false).hasMatch(code);
  }

  Future<void> _updateItem({
    required CustomerOrder order,
    required OrderItemRow item,
    OrderStatus? status,
    String? trackingCode,
    String? pickupCode,
    bool collectPayment = false,
  }) async {
    final api = context.read<ApiClient>();
    try {
      await api.updateOrderItemStatus(
        orderId: order.id,
        itemId: item.id,
        status: status,
        trackingCode: trackingCode,
        pickupCode: pickupCode,
        collectPayment: collectPayment,
      );
      if (!mounted) return;
      _reload();
      final message = collectPayment && status == null
          ? 'Payment collected — marked PAID'
          : status == OrderStatus.delivered
              ? (order.paymentMode == 'cod'
                  ? 'Delivered — COD marked PAID'
                  : 'Marked delivered')
              : status == OrderStatus.shipped
                  ? 'Marked shipped'
                  : status == OrderStatus.readyForPickup
                      ? 'Ready for pickup'
                      : 'Fulfillment updated';
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(message)),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not update fulfillment: $error')),
      );
    }
  }

  Future<void> _openFulfillment(CustomerOrder order, OrderItemRow item) async {
    final s = WingerStrings.of(context);
    final pickupCtrl = TextEditingController(
      text: item.pickupCode ?? _defaultPickupCode(order, item),
    );

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) {
        return AlertDialog(
          title: Text(s.t('fulfillment')),
          content: SizedBox(
            width: 420,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${order.id} · ${item.productName}',
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 4),
                Text(order.customerName, style: TextStyle(color: WingerColors.muted)),
                const SizedBox(height: 12),
                Text(
                  s.t('fulfillPickupHint'),
                  style: TextStyle(color: WingerColors.muted),
                ),
                const SizedBox(height: 16),
                TextField(
                  controller: pickupCtrl,
                  decoration: InputDecoration(labelText: s.t('pickupCode')),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: Text(s.t('cancel')),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: Text(s.t('markReady')),
            ),
          ],
        );
      },
    );

    final pickupCode = pickupCtrl.text.trim();
    pickupCtrl.dispose();
    if (confirmed != true || !mounted) return;

    await _updateItem(
      order: order,
      item: item,
      status: OrderStatus.readyForPickup,
      pickupCode: pickupCode.isEmpty
          ? _defaultPickupCode(order, item)
          : pickupCode,
    );
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
                          const SizedBox(height: 4),
                          Text(
                            '${order.paymentStatus} · ${order.paymentMode}',
                            style: TextStyle(
                              color: order.paymentMode == 'cod' &&
                                      order.paymentStatus == 'PENDING'
                                  ? WingerColors.attentionInk
                                  : WingerColors.muted,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          const SizedBox(height: 8),
                          Text(order.customerName),
                          Text('${item.productName} × ${item.quantity}'),
                          Text('\$${item.lineTotal.toStringAsFixed(2)}'),
                          if (item.trackingCode != null) ...[
                            const SizedBox(height: 4),
                            Text('${s.t('trackingCode')}: ${item.trackingCode}', style: TextStyle(color: WingerColors.muted)),
                          ],
                          if (item.pickupCode != null) ...[
                            const SizedBox(height: 4),
                            Text('${s.t('pickupCode')}: ${item.pickupCode}', style: TextStyle(color: WingerColors.muted)),
                          ],
                          const SizedBox(height: 12),
                          Wrap(
                            spacing: 8,
                            runSpacing: 8,
                            children: [
                              OutlinedButton(
                                onPressed: item.status == OrderStatus.delivered
                                    ? null
                                    : () => _openFulfillment(order, item),
                                child: Text(s.t('fulfillment')),
                              ),
                              FilledButton(
                                onPressed: item.status == OrderStatus.shipped ||
                                        item.status == OrderStatus.delivered
                                    ? null
                                    : () => _updateItem(
                                          order: order,
                                          item: item,
                                          status: OrderStatus.shipped,
                                          trackingCode: _isProductScopedTracking(
                                                    item.trackingCode,
                                                  )
                                              ? _defaultTrackingCode(order, item)
                                              : (item.trackingCode ??
                                                  _defaultTrackingCode(
                                                    order,
                                                    item,
                                                  )),
                                        ),
                                child: Text(s.t('markShipped')),
                              ),
                              FilledButton.tonal(
                                onPressed: item.status == OrderStatus.delivered
                                    ? null
                                    : item.status == OrderStatus.shipped ||
                                            item.status ==
                                                OrderStatus.readyForPickup
                                        ? () => _updateItem(
                                              order: order,
                                              item: item,
                                              status: OrderStatus.delivered,
                                              collectPayment:
                                                  order.paymentMode == 'cod' &&
                                                      order.paymentStatus ==
                                                          'PENDING',
                                            )
                                        : null,
                                child: Text(s.t('markDelivered')),
                              ),
                              if (order.paymentMode == 'cod' &&
                                  order.paymentStatus == 'PENDING')
                                OutlinedButton(
                                  onPressed: () => _updateItem(
                                    order: order,
                                    item: item,
                                    collectPayment: true,
                                  ),
                                  child: Text(s.t('collectPayment')),
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

class SupplierPaymentsScreen extends StatefulWidget {
  const SupplierPaymentsScreen({super.key});

  @override
  State<SupplierPaymentsScreen> createState() => _SupplierPaymentsScreenState();
}

class _SupplierPaymentsScreenState extends State<SupplierPaymentsScreen> {
  Future<_SupplierFinance>? _future;
  final _proposeCtrl = TextEditingController(text: '10');
  final _counterCtrl = TextEditingController();
  bool _busy = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _future ??= _load();
  }

  @override
  void dispose() {
    _proposeCtrl.dispose();
    _counterCtrl.dispose();
    super.dispose();
  }

  Future<_SupplierFinance> _load() async {
    final api = context.read<ApiClient>();
    final summary = await api.fetchSupplierCommissionSummary();
    final agreements = await api.fetchCommissionAgreements();
    final settings = await api.fetchCommissionSettings();
    return _SupplierFinance(
      summary: summary,
      agreements: agreements,
      defaultRate: (settings['defaultCommissionPercent'] as num?)?.toDouble() ?? 10,
    );
  }

  Future<void> _propose() async {
    final session = context.read<AppSession>();
    final supplierId = session.supplierId;
    final rate = double.tryParse(_proposeCtrl.text.trim());
    if (supplierId == null || rate == null) return;
    setState(() => _busy = true);
    try {
      await context.read<ApiClient>().proposeCommissionAgreement(
            supplierId: supplierId,
            ratePercent: rate,
          );
      if (!mounted) return;
      setState(() => _future = _load());
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e.toString().replaceFirst('Exception: ', ''))),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _action(String id, String action, {double? rate}) async {
    setState(() => _busy = true);
    try {
      await context.read<ApiClient>().commissionAgreementAction(
            agreementId: id,
            action: action,
            ratePercent: rate,
          );
      if (!mounted) return;
      setState(() => _future = _load());
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e.toString().replaceFirst('Exception: ', ''))),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final future = _future;
    if (future == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return FutureBuilder<_SupplierFinance>(
      future: future,
      builder: (context, snapshot) {
        final data = snapshot.data;
        final activeRate = (data?.summary['activeRatePercent'] as num?)?.toDouble() ?? data?.defaultRate ?? 10;
        final settleable = (data?.summary['settleableCommission'] as num?)?.toDouble() ?? 0;
        final pending = (data?.summary['pendingCommission'] as num?)?.toDouble() ?? 0;
        final lines = (data?.summary['lines'] as List<dynamic>? ?? const [])
            .cast<Map<String, dynamic>>();
        final agreements = data?.agreements ?? const [];

        return ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Text(s.t('payments'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: 8),
            Text(s.t('commissionSupplierHint'), style: TextStyle(color: WingerColors.muted)),
            const SizedBox(height: 6),
            Text(
              '${s.t('supplierAccount')}: ${context.watch<AppSession>().displayName}'
              '${context.watch<AppSession>().supplierId != null ? ' (${context.watch<AppSession>().supplierId})' : ''}',
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 16),
            if (snapshot.connectionState != ConnectionState.done)
              const Center(child: CircularProgressIndicator())
            else if (snapshot.hasError)
              Text(
                snapshot.error.toString().replaceFirst('Exception: ', ''),
                style: const TextStyle(color: WingerColors.dangerInk),
              )
            else ...[
              GridView.count(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                crossAxisCount: MediaQuery.sizeOf(context).width >= 900 ? 3 : 2,
                mainAxisSpacing: 12,
                crossAxisSpacing: 12,
                childAspectRatio: 1.3,
                children: [
                  KpiCard(data: KpiCardData(label: s.t('activeRate'), value: '${activeRate.toStringAsFixed(1)}%', delta: s.t('commission'))),
                  KpiCard(data: KpiCardData(label: s.t('settleableCommission'), value: '\$${settleable.toStringAsFixed(2)}', delta: s.t('settleable'))),
                  KpiCard(data: KpiCardData(label: s.t('pendingCommission'), value: '\$${pending.toStringAsFixed(2)}', delta: s.t('pending'))),
                ],
              ),
              const SizedBox(height: 16),
              Text(s.t('proposeAgreement'), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
              const SizedBox(height: 8),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Row(
                    children: [
                      SizedBox(
                        width: 120,
                        child: TextField(
                          controller: _proposeCtrl,
                          decoration: InputDecoration(suffixText: '%', labelText: s.t('commissionRate')),
                          keyboardType: const TextInputType.numberWithOptions(decimal: true),
                        ),
                      ),
                      const SizedBox(width: 12),
                      FilledButton(onPressed: _busy ? null : _propose, child: Text(s.t('proposeAgreement'))),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Text(s.t('commissionAgreements'), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
              const SizedBox(height: 8),
              if (agreements.isEmpty)
                Text(s.t('noAgreements'), style: TextStyle(color: WingerColors.muted))
              else
                for (final row in agreements)
                  Card(
                    color: row['status'] == 'APPROVED' ? WingerColors.brandMuted : null,
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            '${row['supplierName'] ?? ''} · ${row['status']} · ${row['effectiveRatePercent'] ?? row['proposedRatePercent']}%',
                            style: const TextStyle(fontWeight: FontWeight.w800),
                          ),
                          if (row['status'] == 'APPROVED')
                            Padding(
                              padding: const EdgeInsets.only(top: 4),
                              child: Text(
                                s.t('awaitingYourAccept'),
                                style: const TextStyle(color: WingerColors.successInk, fontWeight: FontWeight.w600),
                              ),
                            ),
                          if (row['counterRatePercent'] != null)
                            Text('${s.t('counter')}: ${row['counterRatePercent']}%'),
                          if (row['effectiveRatePercent'] != null)
                            Text('${s.t('effective')}: ${row['effectiveRatePercent']}%'),
                          const SizedBox(height: 8),
                          if (row['status'] == 'APPROVED')
                            FilledButton.icon(
                              onPressed: _busy ? null : () => _action(row['id'] as String, 'accept'),
                              icon: const Icon(Icons.check_circle_outline),
                              label: Text(s.t('acceptAgreement')),
                            ),
                          if (row['status'] == 'PROPOSED' || row['status'] == 'COUNTERED' || row['status'] == 'APPROVED') ...[
                            const SizedBox(height: 8),
                            TextField(
                              controller: _counterCtrl,
                              decoration: InputDecoration(labelText: s.t('counterRate'), suffixText: '%'),
                              keyboardType: const TextInputType.numberWithOptions(decimal: true),
                            ),
                            const SizedBox(height: 8),
                            OutlinedButton(
                              onPressed: _busy
                                  ? null
                                  : () async {
                                      final rate = double.tryParse(_counterCtrl.text.trim()) ??
                                          ((row['proposedRatePercent'] as num?)?.toDouble() ?? 10) - 1;
                                      await _action(row['id'] as String, 'counter', rate: rate);
                                    },
                              child: Text(s.t('counter')),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
              const SizedBox(height: 16),
              Text(s.t('commissionLines'), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
              const SizedBox(height: 8),
              if (lines.isEmpty)
                Text(s.t('noCommissionLines'), style: TextStyle(color: WingerColors.muted))
              else
                for (final line in lines)
                  Card(
                    child: ListTile(
                      title: Text('${line['orderId']} · ${line['productName']}'),
                      subtitle: Text(
                        '${line['ratePercent']}% of \$${(line['commissionBase'] as num?)?.toStringAsFixed(2) ?? '0'}',
                      ),
                      trailing: Text(
                        '${line['status']}\n\$${(line['commissionAmount'] as num?)?.toStringAsFixed(2) ?? '0'}',
                        textAlign: TextAlign.end,
                        style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 12),
                      ),
                    ),
                  ),
            ],
          ],
        );
      },
    );
  }
}

class _SupplierFinance {
  const _SupplierFinance({
    required this.summary,
    required this.agreements,
    required this.defaultRate,
  });

  final Map<String, dynamic> summary;
  final List<Map<String, dynamic>> agreements;
  final double defaultRate;
}
