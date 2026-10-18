import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:file_picker/file_picker.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/l10n/winger_strings.dart';
import '../../core/models/models.dart';
import '../../core/offline/sync_engine.dart';
import '../../core/repositories/inventory_repository.dart';
import '../../core/state/app_session.dart';
import '../../core/theme/winger_colors.dart';
import '../../core/util/product_csv.dart';
import '../../core/widgets/chip_scroll_row.dart';
import '../../core/widgets/kpi_card.dart';
import '../../core/widgets/product_photo.dart';
import '../../core/widgets/courier_trip.dart';
import '../../core/widgets/role_shell.dart';
import '../../core/widgets/status_badge.dart';
import '../auth/password_cards.dart';
import '../onboarding/onboarding_checklist.dart';

List<ShellDestination> supplierDestinations({int openReturns = 0}) => [
  const ShellDestination(
    labelKey: 'overview',
    icon: Icons.dashboard_outlined,
    path: '/supplier',
  ),
  const ShellDestination(
    labelKey: 'orders',
    icon: Icons.receipt_long_outlined,
    path: '/supplier/orders',
  ),
  ShellDestination(
    labelKey: 'returns',
    icon: Icons.assignment_return_outlined,
    path: '/supplier/returns',
    badgeCount: openReturns,
  ),
  const ShellDestination(
    labelKey: 'products',
    icon: Icons.inventory_2_outlined,
    path: '/supplier/products',
  ),
  const ShellDestination(
    labelKey: 'deliveryFees',
    icon: Icons.local_shipping_outlined,
    path: '/supplier/delivery',
  ),
  const ShellDestination(
    labelKey: 'payments',
    icon: Icons.payments_outlined,
    path: '/supplier/payments',
  ),
];

class SupplierShell extends StatefulWidget {
  const SupplierShell({super.key, required this.child});

  final Widget child;

  @override
  State<SupplierShell> createState() => _SupplierShellState();
}

class _SupplierShellState extends State<SupplierShell> {
  int _openReturns = 0;
  bool _loadingBadge = false;
  Timer? _badgeTimer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _refreshBadge());
    _badgeTimer = Timer.periodic(const Duration(seconds: 45), (_) {
      if (mounted) _refreshBadge();
    });
  }

  @override
  void dispose() {
    _badgeTimer?.cancel();
    super.dispose();
  }

  Future<void> _refreshBadge() async {
    if (_loadingBadge || !mounted) return;
    final session = context.read<AppSession>();
    if (session.accessToken == null || session.accessToken!.isEmpty) {
      if (_openReturns != 0) setState(() => _openReturns = 0);
      return;
    }
    _loadingBadge = true;
    try {
      final overview = await context.read<ApiClient>().fetchReturnsOverview();
      final open = (overview['openReturns'] as num?)?.toInt() ?? 0;
      final pending = (overview['pendingRefunds'] as num?)?.toInt() ?? 0;
      final next = open + pending;
      if (!mounted) return;
      if (next != _openReturns) setState(() => _openReturns = next);
    } catch (_) {
      // Keep last known badge while offline / unauthorized.
    } finally {
      _loadingBadge = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    return RoleShell(
      title: s.t('dashboard'),
      roleLabel: 'Supplier',
      destinations: supplierDestinations(openReturns: _openReturns),
      child: widget.child,
    );
  }
}

class SupplierDashboardScreen extends StatefulWidget {
  const SupplierDashboardScreen({super.key});

  @override
  State<SupplierDashboardScreen> createState() =>
      _SupplierDashboardScreenState();
}

class _SupplierDashboardScreenState extends State<SupplierDashboardScreen> {
  Future<Map<String, dynamic>>? _future;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _future ??= _load();
  }

  Future<Map<String, dynamic>> _load() async {
    final session = context.read<AppSession>();
    final token = session.accessToken;
    if (token == null || token.isEmpty) {
      throw Exception(
        'Missing Bearer token — sign out and sign in again with API credentials (not local demo mode).',
      );
    }
    return context.read<ApiClient>().fetchSupplierDashboard();
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final wide = MediaQuery.sizeOf(context).width >= 900;
    final future = _future;
    if (future == null) {
      return const Center(child: CircularProgressIndicator());
    }

    return FutureBuilder<Map<String, dynamic>>(
      future: future,
      builder: (context, snapshot) {
        final data = snapshot.data;
        final kpis = <KpiCardData>[
          KpiCardData(
            label: s.t('grossSales'),
            value:
                '\$${((data?['grossSales'] as num?)?.toDouble() ?? 0).toStringAsFixed(0)}',
            delta: '${data?['orderLineCount'] ?? 0} ${s.t('lines')}',
          ),
          KpiCardData(
            label: s.t('openLines'),
            value: '${data?['openLines'] ?? 0}',
            delta: '${data?['shippedLines'] ?? 0} ${s.t('shipped')}',
          ),
          KpiCardData(
            label: s.t('settleableCommission'),
            value:
                '\$${((data?['settleableCommission'] as num?)?.toDouble() ?? 0).toStringAsFixed(2)}',
            delta: s.t('settleable'),
          ),
          KpiCardData(
            label: s.t('products'),
            value: '${data?['productCount'] ?? 0}',
            delta: '${data?['lowStockCount'] ?? 0} ${s.t('lowStock')}',
            positive: ((data?['lowStockCount'] as num?)?.toInt() ?? 0) == 0,
          ),
          KpiCardData(
            label: s.t('openReturns'),
            value: '${data?['openReturns'] ?? 0}',
            delta: s.t('returnsNeedsReview'),
            positive: ((data?['openReturns'] as num?)?.toInt() ?? 0) == 0,
          ),
        ];
        final openReturnsCount = (data?['openReturns'] as num?)?.toInt() ?? 0;

        return ListView(
          padding: const EdgeInsets.all(20),
          children: [
            const OnboardingChecklistCard(journeyRoute: '/supplier/onboarding'),
            Row(
              children: [
                Expanded(
                  child: Text(
                    s.t('overview'),
                    style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                IconButton(
                  onPressed: () => setState(() {
                    _future = _load();
                  }),
                  icon: const Icon(Icons.refresh),
                ),
              ],
            ),
            if (data?['supplierName'] != null)
              Text(
                '${data!['supplierName']}',
                style: TextStyle(
                  color: WingerColors.muted,
                  fontWeight: FontWeight.w600,
                ),
              ),
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerLeft,
              child: OutlinedButton.icon(
                onPressed: () => context.go('/supplier/delivery'),
                icon: const Icon(Icons.local_shipping_outlined),
                label: Text(s.t('deliveryFees')),
              ),
            ),
            const SizedBox(height: 16),
            const ChangePasswordCard(),
            const SizedBox(height: 16),
            if (snapshot.connectionState != ConnectionState.done)
              const Center(child: CircularProgressIndicator())
            else if (snapshot.hasError) ...[
              Card(
                color: WingerColors.brandMuted,
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        s.t('apiLoginRequired'),
                        style: const TextStyle(fontWeight: FontWeight.w800),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        snapshot.error.toString().replaceFirst(
                          'Exception: ',
                          '',
                        ),
                        style: TextStyle(color: WingerColors.muted),
                      ),
                      const SizedBox(height: 12),
                      FilledButton(
                        onPressed: () {
                          context.read<AppSession>().signOut();
                          context.go('/login');
                        },
                        child: Text(s.t('signInAgain')),
                      ),
                    ],
                  ),
                ),
              ),
            ] else ...[
              GridView.count(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                crossAxisCount: wide ? 5 : 2,
                mainAxisSpacing: 12,
                crossAxisSpacing: 12,
                childAspectRatio: wide ? 1.35 : 1.15,
                children: [
                  for (var i = 0; i < kpis.length; i++)
                    KpiCard(
                      data: kpis[i],
                      onTap: i == kpis.length - 1
                          ? () => context.go('/supplier/returns')
                          : null,
                    ),
                ],
              ),
              if (openReturnsCount > 0) ...[
                const SizedBox(height: 16),
                Material(
                  color: WingerColors.attention,
                  borderRadius: BorderRadius.circular(12),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(12),
                    onTap: () => context.go('/supplier/returns'),
                    child: Padding(
                      padding: const EdgeInsets.all(14),
                      child: Row(
                        children: [
                          const Icon(
                            Icons.assignment_return_outlined,
                            color: WingerColors.attentionInk,
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              s
                                  .t('returnsAttentionBanner')
                                  .replaceAll('{n}', '$openReturnsCount'),
                              style: const TextStyle(
                                color: WingerColors.attentionInk,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ),
                          const Icon(
                            Icons.chevron_right,
                            color: WingerColors.attentionInk,
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
              const SizedBox(height: 20),
              Text(
                s.t('orders'),
                style: const TextStyle(
                  fontWeight: FontWeight.w800,
                  fontSize: 18,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                s.t('supplierDashboardHint'),
                style: TextStyle(color: WingerColors.muted),
              ),
              const SizedBox(height: 12),
              ChipScrollRow(
                height: 48,
                children: [
                  FilledButton.tonal(
                    onPressed: () => context.go('/supplier/orders'),
                    child: Text(s.t('orders')),
                  ),
                  FilledButton.tonal(
                    onPressed: () => context.go('/supplier/products'),
                    child: Text(s.t('products')),
                  ),
                  FilledButton.tonal(
                    onPressed: () => context.go('/supplier/returns'),
                    child: Text(
                      openReturnsCount > 0
                          ? '${s.t('returns')} ($openReturnsCount)'
                          : s.t('returns'),
                    ),
                  ),
                  FilledButton.tonal(
                    onPressed: () => context.go('/supplier/payments'),
                    child: Text(s.t('payments')),
                  ),
                ],
              ),
            ],
          ],
        );
      },
    );
  }
}

class SupplierOrdersScreen extends StatefulWidget {
  const SupplierOrdersScreen({super.key});

  @override
  State<SupplierOrdersScreen> createState() => _SupplierOrdersScreenState();
}

enum _FulfillmentFilter { all, open, ready, shipped, delivered }

class _SupplierOrdersScreenState extends State<SupplierOrdersScreen> {
  Future<List<CustomerOrder>>? _future;
  _FulfillmentFilter _filter = _FulfillmentFilter.all;

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

  bool _matchesFilter(OrderItemRow item) {
    switch (_filter) {
      case _FulfillmentFilter.all:
        return true;
      case _FulfillmentFilter.open:
        return item.status == OrderStatus.processing ||
            item.status == OrderStatus.partial;
      case _FulfillmentFilter.ready:
        return item.status == OrderStatus.readyForPickup;
      case _FulfillmentFilter.shipped:
        return item.status == OrderStatus.shipped;
      case _FulfillmentFilter.delivered:
        return item.status == OrderStatus.delivered;
    }
  }

  /// Unique per order line — never derived from product id alone.
  String _defaultTrackingCode(CustomerOrder order, OrderItemRow item) {
    final orderKey = order.id
        .replaceAll(RegExp(r'[^A-Za-z0-9]'), '')
        .toUpperCase();
    final itemKey = item.id
        .replaceAll(RegExp(r'[^A-Za-z0-9]'), '')
        .toUpperCase();
    final shortItem = itemKey.length > 6
        ? itemKey.substring(itemKey.length - 6)
        : itemKey;
    return 'TRK-$orderKey-$shortItem';
  }

  String _defaultPickupCode(CustomerOrder order, OrderItemRow item) {
    final digits = order.id.replaceAll(RegExp(r'[^0-9]'), '');
    final orderPart = digits.length >= 4
        ? digits.substring(digits.length - 4)
        : digits.padLeft(4, '0');
    final itemKey = item.id
        .replaceAll(RegExp(r'[^A-Za-z0-9]'), '')
        .toUpperCase();
    final shortItem = itemKey.length > 4
        ? itemKey.substring(itemKey.length - 4)
        : itemKey;
    return 'PU-$orderPart-$shortItem';
  }

  bool _isProductScopedTracking(String? code) {
    if (code == null) return false;
    // Legacy defaults looked like TRK-P-PULSEWATCH (product id only).
    return RegExp(r'^TRK-P-', caseSensitive: false).hasMatch(code);
  }

  Future<void> _createReplacement(
    CustomerOrder order,
    OrderItemRow item,
  ) async {
    final s = WingerStrings.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(s.t('createReplacement')),
        content: Text(
          s
              .t('createReplacementConfirm')
              .replaceAll('{product}', item.productName)
              .replaceAll('{id}', order.id),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(s.t('back')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(s.t('createReplacement')),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    try {
      final replacement = await context
          .read<ApiClient>()
          .createReplacementOrder(orderId: order.id, itemId: item.id);
      if (!mounted) return;
      _reload();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            s.t('replacementCreated').replaceAll('{id}', replacement.id),
          ),
        ),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(error.toString().replaceFirst('Exception: ', '')),
        ),
      );
    }
  }

  Future<void> _updateItem({
    required CustomerOrder order,
    required OrderItemRow item,
    OrderStatus? status,
    String? trackingCode,
    String? pickupCode,
    bool collectPayment = false,
    Map<String, String?>? courierDetails,
  }) async {
    final s = WingerStrings.of(context);
    final api = context.read<ApiClient>();
    if (collectPayment && status == null) {
      final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text(s.t('collectPayment')),
          content: Text(
            s
                .t('collectPaymentConfirm')
                .replaceAll('{amount}', order.customerPayLabel())
                .replaceAll(
                  '{customer}',
                  order.customerName.isEmpty ? 'customer' : order.customerName,
                )
                .replaceAll('{order}', order.id),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: Text(s.t('back')),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: Text(s.t('collectPayment')),
            ),
          ],
        ),
      );
      if (ok != true || !mounted) return;
    }
    try {
      await api.updateOrderItemStatus(
        orderId: order.id,
        itemId: item.id,
        status: status,
        trackingCode: trackingCode,
        pickupCode: pickupCode,
        collectPayment: collectPayment,
        courierDetails: courierDetails,
      );
      if (!mounted) return;
      _reload();
      final message = collectPayment && status == null
          ? s.t('paymentCollected')
          : status == OrderStatus.delivered
          ? (order.isCodPending
                ? s.t('markedDeliveredCodPending')
                : s.t('markedDelivered'))
          : status == OrderStatus.shipped
          ? s.t('markedShipped')
          : status == OrderStatus.readyForPickup
          ? s.t('markReady')
          : 'Fulfillment updated';
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(message)));
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
                Text(
                  order.customerName,
                  style: TextStyle(color: WingerColors.muted),
                ),
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

  Future<void> _bookCourier(CustomerOrder order, OrderItemRow item) async {
    final s = WingerStrings.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(s.t('bookCourier')),
        content: Text(
          '${order.id} · ${item.productName}\n\n${s.t('bookCourierConfirm')}',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(s.t('cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(s.t('bookCourier')),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    await _updateItem(order: order, item: item, status: OrderStatus.shipped);
  }

  Future<void> _openCourierDetails(
    CustomerOrder order,
    OrderItemRow item,
  ) async {
    final s = WingerStrings.of(context);
    final driverCtrl = TextEditingController(text: item.driverName ?? '');
    final phoneCtrl = TextEditingController(text: item.driverPhone ?? '');
    final plateCtrl = TextEditingController(text: item.plateNumber ?? '');
    final feeCtrl = TextEditingController(
      text: item.courierFee == null ? '' : item.courierFee!.toStringAsFixed(2),
    );
    final linkCtrl = TextEditingController(text: item.trackingUrl ?? '');

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) {
        return AlertDialog(
          title: Text(s.t('courierDetails')),
          content: SizedBox(
            width: 420,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${order.id} · ${item.productName}',
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: driverCtrl,
                    decoration: InputDecoration(labelText: s.t('driverName')),
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    controller: phoneCtrl,
                    decoration: InputDecoration(labelText: s.t('driverPhone')),
                    keyboardType: TextInputType.phone,
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    controller: plateCtrl,
                    decoration: InputDecoration(labelText: s.t('plateNumber')),
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    controller: feeCtrl,
                    decoration: InputDecoration(
                      labelText: s.t('courierFee'),
                      helperText: s.t('courierFeeHint'),
                      helperMaxLines: 2,
                      prefixText: 'USD ',
                    ),
                    keyboardType: const TextInputType.numberWithOptions(
                      decimal: true,
                    ),
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    controller: linkCtrl,
                    decoration: InputDecoration(labelText: s.t('trackingLink')),
                    keyboardType: TextInputType.url,
                  ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: Text(s.t('cancel')),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: Text(s.t('saveCourierDetails')),
            ),
          ],
        );
      },
    );

    final details = {
      'driverName': driverCtrl.text.trim(),
      'driverPhone': phoneCtrl.text.trim(),
      'plateNumber': plateCtrl.text.trim(),
      'courierFee': feeCtrl.text.trim(),
      'trackingUrl': linkCtrl.text.trim(),
    };
    driverCtrl.dispose();
    phoneCtrl.dispose();
    plateCtrl.dispose();
    feeCtrl.dispose();
    linkCtrl.dispose();
    if (confirmed != true || !mounted) return;

    await _updateItem(order: order, item: item, courierDetails: details);
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
        final pairs = <({CustomerOrder order, OrderItemRow item})>[
          for (final order in orders)
            for (final item in order.itemRows)
              if (_matchesFilter(item)) (order: order, item: item),
        ];
        return ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Text(
              s.t('orders'),
              style: Theme.of(
                context,
              ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final entry in <(_FulfillmentFilter, String)>[
                  (_FulfillmentFilter.all, s.t('filterAll')),
                  (_FulfillmentFilter.open, s.t('filterOpen')),
                  (_FulfillmentFilter.ready, s.t('filterReady')),
                  (_FulfillmentFilter.shipped, s.t('filterShipped')),
                  (_FulfillmentFilter.delivered, s.t('filterDelivered')),
                ])
                  FilterChip(
                    label: Text(entry.$2),
                    selected: _filter == entry.$1,
                    onSelected: (_) => setState(() => _filter = entry.$1),
                    selectedColor: WingerColors.brandMuted,
                  ),
              ],
            ),
            const SizedBox(height: 12),
            if (snapshot.connectionState != ConnectionState.done)
              const Padding(
                padding: EdgeInsets.only(top: 24),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (orders.isEmpty)
              Text(
                'No paid orders for your catalogue yet.',
                style: TextStyle(color: WingerColors.muted),
              )
            else if (pairs.isEmpty)
              Text(
                s.t('noOrdersInFilter'),
                style: TextStyle(color: WingerColors.muted),
              )
            else
              for (final pair in pairs)
                Builder(
                  builder: (context) {
                    final order = pair.order;
                    final item = pair.item;
                    return Card(
                      child: Padding(
                        padding: const EdgeInsets.all(16),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Text(
                                  order.id,
                                  style: const TextStyle(
                                    fontWeight: FontWeight.w800,
                                  ),
                                ),
                                const Spacer(),
                                StatusBadge(status: item.status),
                              ],
                            ),
                            const SizedBox(height: 4),
                            Text(
                              '${order.paymentStatus} · ${order.paymentMode}',
                              style: TextStyle(
                                color:
                                    order.paymentMode == 'cod' &&
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
                            if (carrierCaption(
                                  carrier: item.carrier,
                                  courierName: item.courierName,
                                  supplierDelivery: s.t('carrierSupplierLabel'),
                                  courierDelivery: s.t('carrierCourierLabel'),
                                  unnamedCourier: s.t('carrierCourierFallback'),
                                )
                                case final line?) ...[
                              const SizedBox(height: 4),
                              Text(
                                line,
                                style: TextStyle(color: WingerColors.muted),
                              ),
                            ],
                            if (order.isPayOnDelivery &&
                                order.customerPaysOtherCurrency) ...[
                              const SizedBox(height: 4),
                              Text(
                                s
                                    .t('customerPays')
                                    .replaceAll(
                                      '{amount}',
                                      order.customerPayLabel(),
                                    ),
                                style: const TextStyle(
                                  color: WingerColors.attentionInk,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ],
                            if (item.trackingCode != null) ...[
                              const SizedBox(height: 4),
                              Text(
                                item.trackingCode!.startsWith('CR-')
                                    ? s
                                          .t('courierBooked')
                                          .replaceAll(
                                            '{name}',
                                            item.courierName ?? 'Courier',
                                          )
                                          .replaceAll(
                                            '{reference}',
                                            item.trackingCode!,
                                          )
                                    : '${s.t('trackingCode')}: ${item.trackingCode}',
                                style: TextStyle(color: WingerColors.muted),
                              ),
                            ],
                            CourierTripLines(
                              driverName: item.driverName,
                              driverPhone: item.driverPhone,
                              plateNumber: item.plateNumber,
                              fee: item.courierFee,
                              trackingUrl: item.trackingUrl,
                            ),
                            if (item.pickupCode != null) ...[
                              const SizedBox(height: 4),
                              Text(
                                '${s.t('pickupCode')}: ${item.pickupCode}',
                                style: TextStyle(color: WingerColors.muted),
                              ),
                            ],
                            if (item.isReplacement &&
                                item.replacesOrderId != null) ...[
                              const SizedBox(height: 8),
                              Text(
                                s
                                    .t('replacementForOrder')
                                    .replaceAll('{id}', item.replacesOrderId!),
                                style: const TextStyle(
                                  color: WingerColors.successInk,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ],
                            if (item.status == OrderStatus.returned) ...[
                              const SizedBox(height: 8),
                              Text(
                                s.t('returnedLineHint'),
                                style: TextStyle(color: WingerColors.muted),
                              ),
                            ],
                            const SizedBox(height: 12),
                            Wrap(
                              spacing: 8,
                              runSpacing: 8,
                              children: [
                                if (item.status == OrderStatus.returned) ...[
                                  FilledButton(
                                    onPressed: () =>
                                        _createReplacement(order, item),
                                    child: Text(s.t('createReplacement')),
                                  ),
                                  FilledButton.tonal(
                                    onPressed: () =>
                                        context.go('/supplier/returns'),
                                    child: Text(s.t('returns')),
                                  ),
                                ] else ...[
                                  OutlinedButton(
                                    onPressed:
                                        item.status == OrderStatus.delivered
                                        ? null
                                        : () => _openFulfillment(order, item),
                                    child: Text(s.t('fulfillment')),
                                  ),
                                  FilledButton(
                                    onPressed:
                                        item.status == OrderStatus.shipped ||
                                            item.status == OrderStatus.delivered
                                        ? null
                                        : item.carrier == 'courier'
                                        ? () => _bookCourier(order, item)
                                        : () => _updateItem(
                                            order: order,
                                            item: item,
                                            status: OrderStatus.shipped,
                                            trackingCode:
                                                _isProductScopedTracking(
                                                  item.trackingCode,
                                                )
                                                ? _defaultTrackingCode(
                                                    order,
                                                    item,
                                                  )
                                                : (item.trackingCode ??
                                                      _defaultTrackingCode(
                                                        order,
                                                        item,
                                                      )),
                                          ),
                                    child: Text(
                                      item.carrier == 'courier'
                                          ? s.t('bookCourier')
                                          : s.t('markShipped'),
                                    ),
                                  ),
                                  if (item.carrier == 'courier' &&
                                      (item.status == OrderStatus.shipped ||
                                          item.status == OrderStatus.delivered))
                                    OutlinedButton(
                                      onPressed: () =>
                                          _openCourierDetails(order, item),
                                      child: Text(s.t('courierDetails')),
                                    ),
                                  FilledButton.tonal(
                                    onPressed:
                                        item.status == OrderStatus.delivered
                                        ? null
                                        : item.status == OrderStatus.shipped ||
                                              item.status ==
                                                  OrderStatus.readyForPickup
                                        ? () => _updateItem(
                                            order: order,
                                            item: item,
                                            status: OrderStatus.delivered,
                                          )
                                        : null,
                                    child: Text(s.t('markDelivered')),
                                  ),
                                  if (order.isCodPending)
                                    OutlinedButton(
                                      onPressed: () => _updateItem(
                                        order: order,
                                        item: item,
                                        collectPayment: true,
                                      ),
                                      child: Text(s.t('collectPayment')),
                                    ),
                                ],
                              ],
                            ),
                          ],
                        ),
                      ),
                    );
                  },
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
  Future<List<Product>>? _future;
  bool _busy = false;

  String get _supplierId => context.read<AppSession>().supplierId ?? 's-kijani';

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _future ??= _load();
  }

  Future<List<Product>> _load() async {
    final session = context.read<AppSession>();
    final token = session.accessToken;
    if (token == null || token.isEmpty) {
      throw Exception(
        'Missing Bearer token — sign out and sign in again with API credentials (not local demo mode).',
      );
    }
    return context.read<ApiClient>().fetchMyProducts();
  }

  void _reload() {
    setState(() {
      _future = _load();
    });
  }

  Future<void> _receive(Product product) async {
    final inventory = context.read<InventoryRepository>();
    final session = context.read<AppSession>();
    final sync = context.read<SyncEngine>();
    final next = await inventory.receiveStock(
      productId: product.id,
      supplierId: _supplierId,
      quantity: 20,
      userId: session.userId,
    );
    await sync.flush();
    if (!mounted) return;
    _reload();
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          session.apiOnline
              ? 'Received +20 for ${product.name} · stock $next · synced'
              : 'Received +20 for ${product.name} · stock $next · queued offline',
        ),
      ),
    );
  }

  Future<void> _downloadCsvTemplate() async {
    final s = WingerStrings.of(context);
    final saved = await FilePicker.saveFile(
      dialogTitle: s.t('downloadCsvTemplate'),
      fileName: 'winger-products-template.csv',
      bytes: productCsvTemplateBytes(),
    );
    if (!mounted || saved == null) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(s.t('csvTemplateSaved'))));
  }

  Future<void> _importCsv() async {
    final s = WingerStrings.of(context);
    final picked = await FilePicker.pickFiles(
      type: FileType.custom,
      allowedExtensions: const ['csv', 'txt'],
      compressionQuality: 0,
    );
    if (picked.isEmpty || !mounted) return;
    final file = picked.first;
    final path = file.path;
    if (path == null || path.isEmpty) return;

    late final ParsedProductCsv parsed;
    try {
      final bytes = await File(path).readAsBytes();
      if (bytes.isEmpty) {
        throw const FormatException('Could not read CSV file');
      }
      parsed = parseProductCsv(decodeCsvBytes(bytes));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            e is FormatException
                ? e.message
                : e.toString().replaceFirst('Exception: ', ''),
          ),
        ),
      );
      return;
    }

    final products = parsed.products;
    final preview = products.take(5).map((p) => '• ${p['name']}').join('\n');
    final parseNotes = parsed.rowErrors.isEmpty
        ? ''
        : '\n\n${s.t('importCsvSkipped').replaceAll('{n}', '${parsed.rowErrors.length}')}\n'
              '${parsed.rowErrors.take(5).join('\n')}'
              '${parsed.rowErrors.length > 5 ? '\n…' : ''}';
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(s.t('importCsv')),
        content: Text(
          '${s.t('importCsvConfirm').replaceAll('{n}', '${products.length}')}\n\n$preview'
          '${products.length > 5 ? '\n…' : ''}$parseNotes',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(s.t('back')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(s.t('importCsv')),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    setState(() => _busy = true);
    try {
      final result = await context.read<ApiClient>().bulkImportProducts(
        products,
      );
      if (!mounted) return;
      final created = result['createdCount'] as int? ?? 0;
      final updated = result['updatedCount'] as int? ?? 0;
      final failed = result['errorCount'] as int? ?? 0;
      final errors = (result['errors'] as List<dynamic>? ?? const [])
          .cast<Map<String, dynamic>>();
      _reload();
      final summary = s
          .t('importCsvResult')
          .replaceAll('{created}', '$created')
          .replaceAll('{updated}', '$updated')
          .replaceAll('{fail}', '$failed');
      if (errors.isEmpty) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(summary)));
      } else {
        final errorLines = errors
            .take(8)
            .map((e) {
              final row = e['row'];
              final name = e['name'];
              final message = e['message'] ?? '';
              return 'Row $row${name != null ? ' ($name)' : ''}: $message';
            })
            .join('\n');
        await showDialog<void>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: Text(s.t('importCsv')),
            content: Text(
              '$summary\n\n$errorLines${errors.length > 8 ? '\n…' : ''}',
            ),
            actions: [
              FilledButton(
                onPressed: () => Navigator.pop(ctx),
                child: Text(s.t('back')),
              ),
            ],
          ),
        );
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e.toString().replaceFirst('Exception: ', ''))),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _openEditor({Product? product}) async {
    final s = WingerStrings.of(context);
    final draft = await showDialog<_ProductEditorResult>(
      context: context,
      builder: (ctx) => _ProductEditorDialog(product: product),
    );
    if (draft == null || !mounted) return;
    if (draft.taxRateInvalid) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(s.t('taxRateHint'))));
      return;
    }
    if (draft.name.isEmpty ||
        draft.price == null ||
        draft.price! < 0 ||
        draft.stock == null ||
        draft.stock! < 0) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(s.t('productFormInvalid'))));
      return;
    }

    setState(() => _busy = true);
    try {
      final api = context.read<ApiClient>();
      final body = <String, dynamic>{
        'name': draft.name,
        'brand': draft.brand,
        'price': draft.price,
        'stock': draft.stock,
        'category': draft.category.isEmpty ? 'General' : draft.category,
        'model': draft.model.isEmpty ? 'Standard' : draft.model,
        'color': draft.color.isEmpty ? 'Default' : draft.color,
        'size': draft.size.isEmpty ? 'Standard' : draft.size,
        'battery': draft.battery.isEmpty ? '—' : draft.battery,
        'weight': draft.weight.isEmpty ? '—' : draft.weight,
        'extraSpecs': draft.extraSpecs
            .map((spec) => {'label': spec.label, 'value': spec.value})
            .toList(),
        'description': draft.description,
        'taxRatePercent': draft.taxRatePercent,
      };
      late Product saved;
      if (product == null) {
        saved = await api.createMyProduct(body);
      } else {
        for (final imageId in draft.removedImageIds) {
          await api.deleteProductImage(product.id, imageId);
        }
        saved = await api.updateMyProduct(product.id, body);
      }
      if (draft.pendingPhotos.isNotEmpty) {
        await api.uploadProductImages(
          saved.id,
          [
            for (final photo in draft.pendingPhotos)
              ProductPhotoUpload(filename: photo.name, bytes: photo.bytes),
          ],
        );
      }
      if (!mounted) return;
      _reload();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            product == null ? s.t('productCreated') : s.t('productUpdated'),
          ),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      final raw = e.toString().replaceFirst('Exception: ', '');
      final message = raw.toLowerCase().contains('image')
          ? s.t('productImageUploadFailed')
          : raw;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(message)));
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
    return FutureBuilder<List<Product>>(
      future: future,
      builder: (context, snapshot) {
        final rows = snapshot.data ?? [];
        return ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Text(
              s.t('products'),
              style: Theme.of(
                context,
              ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                OutlinedButton.icon(
                  onPressed: _busy ? null : _importCsv,
                  icon: const Icon(Icons.upload_file_outlined),
                  label: Text(s.t('importCsv')),
                ),
                FilledButton.icon(
                  onPressed: _busy ? null : () => _openEditor(),
                  icon: const Icon(Icons.add),
                  label: Text(s.t('addProduct')),
                ),
                IconButton(
                  tooltip: s.t('downloadCsvTemplate'),
                  onPressed: _busy ? null : _downloadCsvTemplate,
                  icon: const Icon(Icons.table_view_outlined),
                ),
                IconButton(
                  tooltip: s.t('retry'),
                  onPressed: _reload,
                  icon: const Icon(Icons.refresh),
                ),
              ],
            ),
            Text(
              s.t('supplierProductsHint'),
              style: TextStyle(
                color: WingerColors.muted,
                fontWeight: FontWeight.w600,
              ),
            ),
            Text(
              s.t('bulkImportHint'),
              style: TextStyle(color: WingerColors.muted, fontSize: 12),
            ),
            const SizedBox(height: 12),
            if (snapshot.connectionState != ConnectionState.done)
              const Padding(
                padding: EdgeInsets.only(top: 24),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (snapshot.hasError)
              Text(
                snapshot.error.toString().replaceFirst('Exception: ', ''),
                style: const TextStyle(color: WingerColors.dangerInk),
              )
            else if (rows.isEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 24),
                child: Text(
                  s.t('noSupplierProducts'),
                  style: TextStyle(
                    color: WingerColors.muted,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              )
            else
              for (final product in rows)
                Card(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 12,
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            ClipRRect(
                              borderRadius: BorderRadius.circular(8),
                              child: SizedBox(
                                width: 56,
                                height: 56,
                                child: ProductPhoto(
                                  url: product.imageUrl,
                                  iconSize: 22,
                                ),
                              ),
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    product.name,
                                    style: const TextStyle(
                                      fontWeight: FontWeight.w700,
                                    ),
                                  ),
                                  const SizedBox(height: 4),
                                  Text(
                                    '\$${product.price.toStringAsFixed(2)} · ${s.t('stock')}: ${product.stock} · ${product.galleryUrls.length} ${s.t('photos')}'
                                    '${product.taxRatePercent == null ? '' : ' · ${s.t('productTaxRate')} ${product.taxRatePercent}%'}',
                                    style: TextStyle(color: WingerColors.muted),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 10),
                        Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          alignment: WrapAlignment.end,
                          children: [
                            OutlinedButton(
                              onPressed: _busy
                                  ? null
                                  : () => _openEditor(product: product),
                              child: Text(s.t('edit')),
                            ),
                            FilledButton(
                              onPressed: _busy ? null : () => _receive(product),
                              child: Text(s.t('receiveStock')),
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

class _PendingPhoto {
  const _PendingPhoto({required this.name, required this.bytes});

  final String name;
  final Uint8List bytes;
}

class _ProductEditorResult {
  const _ProductEditorResult({
    required this.name,
    required this.brand,
    required this.price,
    required this.stock,
    required this.category,
    required this.model,
    required this.color,
    required this.size,
    required this.battery,
    required this.weight,
    required this.extraSpecs,
    required this.description,
    required this.taxRatePercent,
    required this.taxRateInvalid,
    required this.pendingPhotos,
    required this.removedImageIds,
  });

  final String name;
  final String brand;
  final double? price;
  final int? stock;
  final String category;
  final String model;
  final String color;
  final String size;
  final String battery;
  final String weight;
  final List<ProductSpec> extraSpecs;
  final String description;
  final double? taxRatePercent;
  final bool taxRateInvalid;
  final List<_PendingPhoto> pendingPhotos;
  final List<String> removedImageIds;
}

class _ExtraSpecEditors {
  _ExtraSpecEditors({String label = '', String value = ''})
    : labelCtrl = TextEditingController(text: label),
      valueCtrl = TextEditingController(text: value);

  final TextEditingController labelCtrl;
  final TextEditingController valueCtrl;

  void dispose() {
    labelCtrl.dispose();
    valueCtrl.dispose();
  }
}

class _ProductEditorDialog extends StatefulWidget {
  const _ProductEditorDialog({this.product});

  final Product? product;

  @override
  State<_ProductEditorDialog> createState() => _ProductEditorDialogState();
}

class _ProductEditorDialogState extends State<_ProductEditorDialog> {
  static const _maxImages = 8;

  late final TextEditingController _nameCtrl;
  late final TextEditingController _brandCtrl;
  late final TextEditingController _priceCtrl;
  late final TextEditingController _stockCtrl;
  late final TextEditingController _categoryCtrl;
  late final TextEditingController _modelCtrl;
  late final TextEditingController _colorCtrl;
  late final TextEditingController _sizeCtrl;
  late final TextEditingController _batteryCtrl;
  late final TextEditingController _weightCtrl;
  late final TextEditingController _descCtrl;
  late final TextEditingController _taxCtrl;
  late List<ProductImageRef> _existing;
  final List<_ExtraSpecEditors> _extraSpecs = [];
  final List<_PendingPhoto> _pendingPhotos = [];
  final List<String> _removedImageIds = [];

  @override
  void initState() {
    super.initState();
    final product = widget.product;
    _nameCtrl = TextEditingController(text: product?.name ?? '');
    _brandCtrl = TextEditingController(text: product?.brand ?? '');
    _priceCtrl = TextEditingController(
      text: product != null ? product.price.toStringAsFixed(2) : '',
    );
    _stockCtrl = TextEditingController(
      text: product != null ? '${product.stock}' : '10',
    );
    _categoryCtrl = TextEditingController(
      text: product == null || product.category == 'General'
          ? ''
          : product.category,
    );
    _modelCtrl = TextEditingController(
      text: product == null || product.model == 'Standard' ? '' : product.model,
    );
    _colorCtrl = TextEditingController(
      text:
          product == null ||
              product.color == 'Default' ||
              product.color == 'Graphite'
          ? ''
          : product.color,
    );
    _sizeCtrl = TextEditingController(
      text:
          product == null ||
              product.size == 'Standard' ||
              product.size == 'One size'
          ? ''
          : product.size,
    );
    _batteryCtrl = TextEditingController(
      text: product == null || product.battery == '—' ? '' : product.battery,
    );
    _weightCtrl = TextEditingController(
      text: product == null || product.weight == '—' ? '' : product.weight,
    );
    _descCtrl = TextEditingController(text: product?.description ?? '');
    final productTax = product?.taxRatePercent;
    _taxCtrl = TextEditingController(
      text: productTax == null
          ? ''
          : (productTax == productTax.roundToDouble()
                ? productTax.round().toString()
                : productTax.toStringAsFixed(2)),
    );
    _existing = [...?product?.images];
    for (final spec in product?.extraSpecs ?? const <ProductSpec>[]) {
      _extraSpecs.add(_ExtraSpecEditors(label: spec.label, value: spec.value));
    }
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _brandCtrl.dispose();
    _priceCtrl.dispose();
    _stockCtrl.dispose();
    _categoryCtrl.dispose();
    _modelCtrl.dispose();
    _colorCtrl.dispose();
    _sizeCtrl.dispose();
    _batteryCtrl.dispose();
    _weightCtrl.dispose();
    _descCtrl.dispose();
    _taxCtrl.dispose();
    for (final row in _extraSpecs) {
      row.dispose();
    }
    super.dispose();
  }

  int get _totalCount => _existing.length + _pendingPhotos.length;

  static const _minImageEdge = 600;

  Future<void> _pickImages() async {
    final s = WingerStrings.of(context);
    final remaining = _maxImages - _totalCount;
    if (remaining <= 0) return;
    final result = await FilePicker.pickFiles(
      type: FileType.image,
      compressionQuality: 0,
    );
    if (result.isEmpty) return;

    final accepted = <_PendingPhoto>[];
    var rejectedSmall = 0;
    for (final file in result.take(remaining)) {
      Uint8List bytes;
      try {
        bytes = await file.readAsBytes();
      } catch (_) {
        rejectedSmall += 1;
        continue;
      }
      if (accepted.length >= remaining) break;
      final ok = await _isImageLargeEnough(bytes);
      if (ok) {
        final name = file.name.trim().isEmpty ? 'photo.jpg' : file.name.trim();
        accepted.add(_PendingPhoto(name: name, bytes: bytes));
      } else {
        rejectedSmall += 1;
      }
    }

    if (!mounted) return;
    if (accepted.isNotEmpty) {
      setState(() => _pendingPhotos.addAll(accepted));
    }
    if (rejectedSmall > 0) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(s.t('productImageTooSmall'))));
    }
  }

  Future<bool> _isImageLargeEnough(Uint8List bytes) async {
    try {
      if (bytes.length < 20 * 1024) return false;
      final codec = await ui.instantiateImageCodec(bytes);
      final frame = await codec.getNextFrame();
      final width = frame.image.width;
      final height = frame.image.height;
      frame.image.dispose();
      return width >= _minImageEdge && height >= _minImageEdge;
    } catch (_) {
      return false;
    }
  }

  void _submit() {
    Navigator.pop(
      context,
      _ProductEditorResult(
        name: _nameCtrl.text.trim(),
        brand: _brandCtrl.text.trim(),
        price: double.tryParse(_priceCtrl.text.trim()),
        stock: int.tryParse(_stockCtrl.text.trim()),
        category: _categoryCtrl.text.trim(),
        model: _modelCtrl.text.trim(),
        color: _colorCtrl.text.trim(),
        size: _sizeCtrl.text.trim(),
        battery: _batteryCtrl.text.trim(),
        weight: _weightCtrl.text.trim(),
        extraSpecs: [
          for (final row in _extraSpecs)
            if (row.labelCtrl.text.trim().isNotEmpty &&
                row.valueCtrl.text.trim().isNotEmpty)
              ProductSpec(
                label: row.labelCtrl.text.trim(),
                value: row.valueCtrl.text.trim(),
              ),
        ],
        description: _descCtrl.text.trim(),
        taxRatePercent: _taxCtrl.text.trim().isEmpty
            ? null
            : double.tryParse(_taxCtrl.text.trim()),
        taxRateInvalid:
            _taxCtrl.text.trim().isNotEmpty &&
            (double.tryParse(_taxCtrl.text.trim()) == null ||
                double.parse(_taxCtrl.text.trim()) < 0 ||
                double.parse(_taxCtrl.text.trim()) > 100),
        pendingPhotos: List<_PendingPhoto>.from(_pendingPhotos),
        removedImageIds: List<String>.from(_removedImageIds),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    return AlertDialog(
      title: Text(
        widget.product == null ? s.t('addProduct') : s.t('editProduct'),
      ),
      content: SizedBox(
        width: 520,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                s.t('photos'),
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 4),
              Text(
                s.t('productPhotosHint'),
                style: TextStyle(color: WingerColors.muted, fontSize: 12),
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final image in _existing)
                    _EditorThumb(
                      child: ProductPhoto(url: image.url, iconSize: 22),
                      onRemove: () {
                        setState(() {
                          _existing.removeWhere((row) => row.id == image.id);
                          if (!image.id.startsWith('cover-') &&
                              !isProductImageMissing(image.url)) {
                            _removedImageIds.add(image.id);
                          }
                        });
                      },
                    ),
                  for (var i = 0; i < _pendingPhotos.length; i++)
                    _EditorThumb(
                      child: Image.memory(
                        _pendingPhotos[i].bytes,
                        fit: BoxFit.cover,
                        errorBuilder: (_, __, ___) =>
                            const Icon(Icons.broken_image_outlined),
                      ),
                      onRemove: () => setState(() => _pendingPhotos.removeAt(i)),
                    ),
                  if (_totalCount < _maxImages)
                    OutlinedButton.icon(
                      onPressed: _pickImages,
                      icon: const Icon(Icons.add_photo_alternate_outlined),
                      label: Text(s.t('addPhotos')),
                    ),
                ],
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _nameCtrl,
                decoration: InputDecoration(labelText: s.t('productName')),
              ),
              TextField(
                controller: _brandCtrl,
                decoration: InputDecoration(labelText: s.t('brand')),
              ),
              TextField(
                controller: _priceCtrl,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                decoration: InputDecoration(labelText: s.t('price')),
              ),
              TextField(
                controller: _taxCtrl,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                decoration: InputDecoration(
                  labelText: s.t('productTaxRate'),
                  suffixText: '%',
                  helperText: s.t('productTaxHint'),
                  helperMaxLines: 3,
                ),
              ),
              TextField(
                controller: _stockCtrl,
                keyboardType: TextInputType.number,
                decoration: InputDecoration(labelText: s.t('stock')),
              ),
              const SizedBox(height: 8),
              Text(
                s.t('specifications'),
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 2),
              Text(
                s.t('specificationsHint'),
                style: TextStyle(color: WingerColors.muted, fontSize: 12),
              ),
              TextField(
                controller: _categoryCtrl,
                decoration: InputDecoration(labelText: s.t('categories')),
              ),
              TextField(
                controller: _modelCtrl,
                decoration: InputDecoration(labelText: s.t('sku')),
              ),
              TextField(
                controller: _colorCtrl,
                decoration: InputDecoration(labelText: s.t('color')),
              ),
              TextField(
                controller: _sizeCtrl,
                decoration: InputDecoration(labelText: s.t('size')),
              ),
              TextField(
                controller: _batteryCtrl,
                decoration: InputDecoration(labelText: s.t('battery')),
              ),
              TextField(
                controller: _weightCtrl,
                decoration: InputDecoration(labelText: s.t('weight')),
              ),
              const SizedBox(height: 8),
              for (var i = 0; i < _extraSpecs.length; i++)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _extraSpecs[i].labelCtrl,
                          decoration: InputDecoration(
                            labelText: s.t('customSpecLabel'),
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: TextField(
                          controller: _extraSpecs[i].valueCtrl,
                          decoration: InputDecoration(
                            labelText: s.t('customSpecValue'),
                          ),
                        ),
                      ),
                      IconButton(
                        tooltip: s.t('remove'),
                        onPressed: () {
                          setState(() {
                            _extraSpecs.removeAt(i).dispose();
                          });
                        },
                        icon: const Icon(Icons.close),
                      ),
                    ],
                  ),
                ),
              if (_extraSpecs.length < 20)
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton.icon(
                    onPressed: () =>
                        setState(() => _extraSpecs.add(_ExtraSpecEditors())),
                    icon: const Icon(Icons.add),
                    label: Text(s.t('addSpecField')),
                  ),
                ),
              TextField(
                controller: _descCtrl,
                maxLines: 3,
                decoration: InputDecoration(labelText: s.t('description')),
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text(s.t('back')),
        ),
        FilledButton(onPressed: _submit, child: Text(s.t('save'))),
      ],
    );
  }
}

class _EditorThumb extends StatelessWidget {
  const _EditorThumb({required this.child, required this.onRemove});

  final Widget child;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: SizedBox(width: 72, height: 72, child: child),
        ),
        Positioned(
          top: 0,
          right: 0,
          child: Material(
            color: Colors.black54,
            shape: const CircleBorder(),
            child: InkWell(
              customBorder: const CircleBorder(),
              onTap: onRemove,
              child: const Padding(
                padding: EdgeInsets.all(2),
                child: Icon(Icons.close, size: 14, color: Colors.white),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

String _payoutsSentLabel(List<Map<String, dynamic>> payouts) {
  if (payouts.isEmpty) return '\$0.00';
  return payouts
      .map((row) {
        final currency = (row['currency'] as String?)?.toUpperCase() ?? 'USD';
        final amount = (row['amount'] as num?)?.toDouble() ?? 0;
        final text = amount.toStringAsFixed(2);
        return currency == 'USD' ? '\$$text' : '$currency $text';
      })
      .join(', ');
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
    final session = context.read<AppSession>();
    if (session.accessToken == null || session.accessToken!.isEmpty) {
      throw Exception(
        'Missing Bearer token — sign out and sign in again with API credentials (not local demo mode).',
      );
    }
    final api = context.read<ApiClient>();
    final summary = await api.fetchSupplierCommissionSummary();
    final agreements = await api.fetchCommissionAgreements();
    final settings = await api.fetchCommissionSettings();
    final connect = await api.fetchConnectStatus();
    return _SupplierFinance(
      summary: summary,
      agreements: agreements,
      defaultRate:
          (settings['defaultCommissionPercent'] as num?)?.toDouble() ?? 10,
      connect: connect,
    );
  }

  Future<void> _connectPayouts() async {
    setState(() => _busy = true);
    try {
      final url = await context.read<ApiClient>().startConnectOnboarding();
      final opened = await launchUrl(
        Uri.parse(url),
        mode: LaunchMode.externalApplication,
      );
      if (!opened && mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(url)));
      }
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(error.toString().replaceFirst('Exception: ', '')),
        ),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _sendPayouts() async {
    setState(() => _busy = true);
    try {
      final result = await context.read<ApiClient>().sendSettleablePayouts();
      if (!mounted) return;
      final sent = (result['transferred'] as num?)?.toInt() ?? 0;
      final s = WingerStrings.of(context);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            sent > 0 ? '${s.t('payoutSent')} ($sent)' : s.t('payoutNone'),
          ),
        ),
      );
      setState(() {
        _future = _load();
      });
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(error.toString().replaceFirst('Exception: ', '')),
        ),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
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
      setState(() {
        _future = _load();
      });
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
      setState(() {
        _future = _load();
      });
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
        final activeRate =
            (data?.summary['activeRatePercent'] as num?)?.toDouble() ??
            data?.defaultRate ??
            10;
        final commissionWaiting =
            (data?.summary['commissionWaiting'] as num?)?.toDouble() ?? 0;
        final cashCommission =
            (data?.summary['cashCommission'] as num?)?.toDouble() ?? 0;
        final payoutsSent =
            (data?.summary['payoutsSent'] as List<dynamic>? ?? const [])
                .cast<Map<String, dynamic>>();
        final recognized =
            (data?.summary['recognizedCommission'] as num?)?.toDouble() ?? 0;
        final pending =
            (data?.summary['pendingCommission'] as num?)?.toDouble() ?? 0;
        final lines = (data?.summary['lines'] as List<dynamic>? ?? const [])
            .cast<Map<String, dynamic>>();
        final agreements = data?.agreements ?? const [];

        return ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Text(
              s.t('payments'),
              style: Theme.of(
                context,
              ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 8),
            Text(
              s.t('payoutsHint'),
              style: TextStyle(color: WingerColors.muted),
            ),
            const SizedBox(height: 12),
            if (data?.connect['payoutsEnabled'] == true)
              Text(
                s.t('payoutsConnected'),
                style: const TextStyle(fontWeight: FontWeight.w700),
              )
            else
              FilledButton(
                onPressed: _busy ? null : _connectPayouts,
                child: Text(s.t('connectPayouts')),
              ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                OutlinedButton(
                  onPressed: _busy
                      ? null
                      : () => setState(() {
                          _future = _load();
                        }),
                  child: Text(s.t('refreshPayouts')),
                ),
                if (data?.connect['payoutsEnabled'] == true)
                  FilledButton(
                    onPressed: _busy ? null : _sendPayouts,
                    child: Text(s.t('sendPayouts')),
                  ),
              ],
            ),
            const SizedBox(height: 16),
            Text(
              s.t('commissionSupplierHint'),
              style: TextStyle(color: WingerColors.muted),
            ),
            const SizedBox(height: 6),
            Text(
              '${s.t('supplierAccount')}: ${context.watch<AppSession>().displayName}'
              '${context.watch<AppSession>().supplierId != null ? ' (${context.watch<AppSession>().supplierId})' : ''}',
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 16),
            if (snapshot.connectionState != ConnectionState.done)
              const Center(child: CircularProgressIndicator())
            else if (snapshot.hasError) ...[
              Text(
                snapshot.error.toString().replaceFirst('Exception: ', ''),
                style: const TextStyle(color: WingerColors.dangerInk),
              ),
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: () {
                  context.read<AppSession>().signOut();
                  context.go('/login');
                },
                icon: const Icon(Icons.login),
                label: Text(s.t('signInAgain')),
              ),
              const SizedBox(height: 8),
              TextButton(
                onPressed: () => setState(() {
                  _future = _load();
                }),
                child: Text(s.t('retry')),
              ),
            ] else ...[
              GridView.count(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                crossAxisCount: MediaQuery.sizeOf(context).width >= 900 ? 3 : 2,
                mainAxisSpacing: 12,
                crossAxisSpacing: 12,
                childAspectRatio: MediaQuery.sizeOf(context).width >= 900
                    ? 1.45
                    : 0.95,
                children: [
                  KpiCard(
                    data: KpiCardData(
                      label: s.t('activeRate'),
                      value: '${activeRate.toStringAsFixed(1)}%',
                      delta: s.t('commission'),
                    ),
                  ),
                  KpiCard(
                    data: KpiCardData(
                      label: s.t('commissionWaiting'),
                      value: '\$${commissionWaiting.toStringAsFixed(2)}',
                      delta: s.t('notPaidOut'),
                    ),
                  ),
                  KpiCard(
                    data: KpiCardData(
                      label: s.t('cashStaysInWinger'),
                      value: '\$${cashCommission.toStringAsFixed(2)}',
                      delta: s.t('notSentToStripe'),
                    ),
                  ),
                  KpiCard(
                    data: KpiCardData(
                      label: s.t('payoutsAlreadySent'),
                      value: _payoutsSentLabel(payoutsSent),
                      delta: s.t('acceptedByStripe'),
                    ),
                  ),
                  KpiCard(
                    data: KpiCardData(
                      label: s.t('recognizedCommission'),
                      value: '\$${recognized.toStringAsFixed(2)}',
                      delta: s.t('recognized'),
                    ),
                  ),
                  KpiCard(
                    data: KpiCardData(
                      label: s.t('pendingCommission'),
                      value: '\$${pending.toStringAsFixed(2)}',
                      delta: s.t('pending'),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                s.t('payoutSplitHint'),
                style: TextStyle(color: WingerColors.muted),
              ),
              const SizedBox(height: 16),
              Text(
                s.t('proposeAgreement'),
                style: const TextStyle(
                  fontWeight: FontWeight.w800,
                  fontSize: 18,
                ),
              ),
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
                          decoration: InputDecoration(
                            suffixText: '%',
                            labelText: s.t('commissionRate'),
                          ),
                          keyboardType: const TextInputType.numberWithOptions(
                            decimal: true,
                          ),
                        ),
                      ),
                      const SizedBox(width: 12),
                      FilledButton(
                        onPressed: _busy ? null : _propose,
                        child: Text(s.t('proposeAgreement')),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Text(
                s.t('commissionAgreements'),
                style: const TextStyle(
                  fontWeight: FontWeight.w800,
                  fontSize: 18,
                ),
              ),
              const SizedBox(height: 8),
              if (agreements.isEmpty)
                Text(
                  s.t('noAgreements'),
                  style: TextStyle(color: WingerColors.muted),
                )
              else
                for (final row in agreements)
                  Card(
                    color: row['status'] == 'APPROVED'
                        ? WingerColors.brandMuted
                        : null,
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
                                style: const TextStyle(
                                  color: WingerColors.successInk,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                          if (row['counterRatePercent'] != null)
                            Text(
                              '${s.t('counter')}: ${row['counterRatePercent']}%',
                            ),
                          if (row['effectiveRatePercent'] != null)
                            Text(
                              '${s.t('effective')}: ${row['effectiveRatePercent']}%',
                            ),
                          const SizedBox(height: 8),
                          if (row['status'] == 'APPROVED')
                            FilledButton.icon(
                              onPressed: _busy
                                  ? null
                                  : () =>
                                        _action(row['id'] as String, 'accept'),
                              icon: const Icon(Icons.check_circle_outline),
                              label: Text(s.t('acceptAgreement')),
                            ),
                          if (row['status'] == 'PROPOSED' ||
                              row['status'] == 'COUNTERED' ||
                              row['status'] == 'APPROVED') ...[
                            const SizedBox(height: 8),
                            TextField(
                              controller: _counterCtrl,
                              decoration: InputDecoration(
                                labelText: s.t('counterRate'),
                                suffixText: '%',
                              ),
                              keyboardType:
                                  const TextInputType.numberWithOptions(
                                    decimal: true,
                                  ),
                            ),
                            const SizedBox(height: 8),
                            OutlinedButton(
                              onPressed: _busy
                                  ? null
                                  : () async {
                                      final rate =
                                          double.tryParse(
                                            _counterCtrl.text.trim(),
                                          ) ??
                                          ((row['proposedRatePercent'] as num?)
                                                      ?.toDouble() ??
                                                  10) -
                                              1;
                                      await _action(
                                        row['id'] as String,
                                        'counter',
                                        rate: rate,
                                      );
                                    },
                              child: Text(s.t('counter')),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
              const SizedBox(height: 16),
              Text(
                s.t('commissionLines'),
                style: const TextStyle(
                  fontWeight: FontWeight.w800,
                  fontSize: 18,
                ),
              ),
              const SizedBox(height: 8),
              if (lines.isEmpty)
                Text(
                  s.t('noCommissionLines'),
                  style: TextStyle(color: WingerColors.muted),
                )
              else
                for (final line in lines)
                  Card(
                    child: ListTile(
                      title: Text(
                        '${line['orderId']} · ${line['productName']}',
                      ),
                      subtitle: Text(
                        [
                          '${line['ratePercent']}% of \$${(line['commissionBase'] as num?)?.toStringAsFixed(2) ?? '0'}',
                          if (line['paymentMode'] == 'cod')
                            s.t('cashStaysInWinger'),
                          if (line['transferAmount'] != null &&
                              line['transferReversed'] != true)
                            '${s.t('payoutSent')} ${line['transferCurrency'] ?? 'USD'} ${(line['transferAmount'] as num).toStringAsFixed(2)}',
                        ].join('\n'),
                      ),
                      trailing: Text(
                        '${line['status']}\n\$${(line['commissionAmount'] as num?)?.toStringAsFixed(2) ?? '0'}',
                        textAlign: TextAlign.end,
                        style: const TextStyle(
                          fontWeight: FontWeight.w700,
                          fontSize: 12,
                        ),
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

class _CityTaxEditors {
  _CityTaxEditors({String city = '', String rate = ''})
    : cityCtrl = TextEditingController(text: city),
      rateCtrl = TextEditingController(text: rate);

  final TextEditingController cityCtrl;
  final TextEditingController rateCtrl;

  void dispose() {
    cityCtrl.dispose();
    rateCtrl.dispose();
  }
}

class _SupplierFinance {
  const _SupplierFinance({
    required this.summary,
    required this.agreements,
    required this.defaultRate,
    required this.connect,
  });

  final Map<String, dynamic> summary;
  final List<Map<String, dynamic>> agreements;
  final double defaultRate;
  final Map<String, dynamic> connect;
}

class SupplierDeliveryFeesScreen extends StatefulWidget {
  const SupplierDeliveryFeesScreen({super.key});

  @override
  State<SupplierDeliveryFeesScreen> createState() =>
      _SupplierDeliveryFeesScreenState();
}

class _SupplierDeliveryFeesScreenState
    extends State<SupplierDeliveryFeesScreen> {
  final _standardCtrl = TextEditingController();
  final _expressCtrl = TextEditingController();
  final _pickupCtrl = TextEditingController();
  final _thresholdCtrl = TextEditingController();
  final _taxCtrl = TextEditingController();
  final _courierCtrl = TextEditingController();
  final List<_CityTaxEditors> _cityTaxes = [];
  bool _taxOnDelivery = false;
  String _carrier = 'supplier';
  bool _loading = true;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(_load());
    });
  }

  @override
  void dispose() {
    _standardCtrl.dispose();
    _expressCtrl.dispose();
    _pickupCtrl.dispose();
    _thresholdCtrl.dispose();
    _taxCtrl.dispose();
    _courierCtrl.dispose();
    for (final row in _cityTaxes) {
      row.dispose();
    }
    super.dispose();
  }

  String _moneyText(num? value) {
    if (value == null) return '';
    final amount = value.toDouble();
    return amount == amount.roundToDouble()
        ? amount.round().toString()
        : amount.toStringAsFixed(2);
  }

  Future<void> _load() async {
    try {
      final fees = await context.read<ApiClient>().fetchMyDeliveryFees();
      if (!mounted) return;
      setState(() {
        _standardCtrl.text = _moneyText(fees['standardDeliveryFee'] as num?);
        _expressCtrl.text = _moneyText(fees['expressDeliveryFee'] as num?);
        _pickupCtrl.text = _moneyText(fees['pickupDeliveryFee'] as num?);
        _thresholdCtrl.text = _moneyText(fees['freeDeliveryThreshold'] as num?);
        _taxCtrl.text = _moneyText(fees['taxRatePercent'] as num? ?? 8);
        _taxOnDelivery = fees['taxOnDelivery'] as bool? ?? false;
        for (final row in _cityTaxes) {
          row.dispose();
        }
        _cityTaxes
          ..clear()
          ..addAll(
            (fees['taxCities'] as List<dynamic>? ?? const [])
                .whereType<Map>()
                .map(
                  (row) => _CityTaxEditors(
                    city: row['city']?.toString() ?? '',
                    rate: _moneyText(row['taxRatePercent'] as num?),
                  ),
                ),
          );
        _carrier = fees['carrier'] == 'courier' ? 'courier' : 'supplier';
        _courierCtrl.text = fees['courierName'] as String? ?? '';
        _loading = false;
        _error = null;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = error.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  double? _parseFee(String raw) {
    final text = raw.trim();
    if (text.isEmpty) return null;
    return double.tryParse(text);
  }

  Future<void> _save() async {
    final s = WingerStrings.of(context);
    final standard = _parseFee(_standardCtrl.text);
    final express = _parseFee(_expressCtrl.text);
    final pickup = _parseFee(_pickupCtrl.text);
    final thresholdText = _thresholdCtrl.text.trim();
    final threshold = thresholdText.isEmpty
        ? null
        : double.tryParse(thresholdText);
    if (standard == null ||
        express == null ||
        pickup == null ||
        standard < 0 ||
        express < 0 ||
        pickup < 0) {
      setState(() => _error = s.t('deliveryFeesHint'));
      return;
    }
    if (thresholdText.isNotEmpty && (threshold == null || threshold <= 0)) {
      setState(() => _error = s.t('freeDeliveryThresholdHint'));
      return;
    }
    final taxRate = _parseFee(_taxCtrl.text);
    if (taxRate == null || taxRate < 0 || taxRate > 100) {
      setState(() => _error = s.t('taxRateHint'));
      return;
    }
    final taxCities = <Map<String, dynamic>>[];
    for (final row in _cityTaxes) {
      final city = row.cityCtrl.text.trim();
      final rateText = row.rateCtrl.text.trim();
      if (city.isEmpty && rateText.isEmpty) continue;
      final rate = double.tryParse(rateText);
      if (city.isEmpty || rate == null || rate < 0 || rate > 100) {
        setState(() => _error = s.t('taxCityRequired'));
        return;
      }
      taxCities.add({'city': city, 'taxRatePercent': rate});
    }
    final courierName = _courierCtrl.text.trim();
    if (_carrier == 'courier' && courierName.isEmpty) {
      setState(() => _error = s.t('courierNameRequired'));
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await context.read<ApiClient>().updateMyDeliveryFees(
        standardDeliveryFee: standard,
        expressDeliveryFee: express,
        pickupDeliveryFee: pickup,
        freeDeliveryThreshold: threshold,
        taxRatePercent: taxRate,
        taxOnDelivery: _taxOnDelivery,
        taxCities: taxCities,
        carrier: _carrier,
        courierName: courierName.isEmpty ? null : courierName,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(s.t('deliveryFeesSaved'))));
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    if (_loading) return const Center(child: CircularProgressIndicator());
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text(
          s.t('deliveryFees'),
          style: Theme.of(
            context,
          ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
        ),
        const SizedBox(height: 8),
        Text(
          s.t('deliveryFeesHint'),
          style: TextStyle(color: WingerColors.muted),
        ),
        const SizedBox(height: 20),
        Text(
          s.t('carrierSection'),
          style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
        ),
        const SizedBox(height: 8),
        Text(s.t('carrierHint'), style: TextStyle(color: WingerColors.muted)),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            ChoiceChip(
              label: Text(s.t('carrierSupplier')),
              selected: _carrier == 'supplier',
              selectedColor: WingerColors.brandMuted,
              onSelected: (_) => setState(() => _carrier = 'supplier'),
            ),
            ChoiceChip(
              label: Text(s.t('carrierCourier')),
              selected: _carrier == 'courier',
              selectedColor: WingerColors.brandMuted,
              onSelected: (_) => setState(() => _carrier = 'courier'),
            ),
          ],
        ),
        if (_carrier == 'courier') ...[
          const SizedBox(height: 12),
          TextField(
            controller: _courierCtrl,
            decoration: InputDecoration(
              labelText: s.t('courierName'),
              helperText: s.t('courierNameRequired'),
              helperMaxLines: 2,
            ),
          ),
        ],
        const SizedBox(height: 16),
        TextField(
          controller: _standardCtrl,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: InputDecoration(
            labelText: s.t('standardDelivery'),
            prefixText: 'USD ',
          ),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _expressCtrl,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: InputDecoration(
            labelText: s.t('expressDelivery'),
            prefixText: 'USD ',
          ),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _pickupCtrl,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: InputDecoration(
            labelText: s.t('pickupDelivery'),
            prefixText: 'USD ',
          ),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _thresholdCtrl,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: InputDecoration(
            labelText: s.t('freeDeliveryThreshold'),
            prefixText: 'USD ',
            helperText: s.t('freeDeliveryThresholdHint'),
            helperMaxLines: 4,
          ),
        ),
        const SizedBox(height: 20),
        Text(
          s.t('taxSection'),
          style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
        ),
        const SizedBox(height: 8),
        TextField(
          controller: _taxCtrl,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: InputDecoration(
            labelText: s.t('taxRate'),
            suffixText: '%',
            helperText: s.t('taxRateHint'),
            helperMaxLines: 3,
          ),
        ),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(s.t('taxOnDelivery')),
          value: _taxOnDelivery,
          activeThumbColor: WingerColors.brand,
          onChanged: (value) => setState(() => _taxOnDelivery = value),
        ),
        const SizedBox(height: 8),
        Text(
          s.t('taxByCity'),
          style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16),
        ),
        const SizedBox(height: 4),
        Text(s.t('taxByCityHint'), style: TextStyle(color: WingerColors.muted)),
        const SizedBox(height: 8),
        for (var i = 0; i < _cityTaxes.length; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  flex: 3,
                  child: TextField(
                    controller: _cityTaxes[i].cityCtrl,
                    decoration: InputDecoration(labelText: s.t('taxCity')),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  flex: 2,
                  child: TextField(
                    controller: _cityTaxes[i].rateCtrl,
                    keyboardType: const TextInputType.numberWithOptions(
                      decimal: true,
                    ),
                    decoration: InputDecoration(
                      labelText: s.t('taxRate'),
                      suffixText: '%',
                    ),
                  ),
                ),
                IconButton(
                  onPressed: () => setState(() {
                    _cityTaxes.removeAt(i).dispose();
                  }),
                  icon: const Icon(Icons.close),
                ),
              ],
            ),
          ),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            onPressed: _cityTaxes.length >= 30
                ? null
                : () => setState(() => _cityTaxes.add(_CityTaxEditors())),
            icon: const Icon(Icons.add),
            label: Text(s.t('addTaxCity')),
          ),
        ),
        if (_error != null) ...[
          const SizedBox(height: 12),
          Text(
            _error!,
            style: const TextStyle(
              color: Colors.red,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
        const SizedBox(height: 16),
        FilledButton(
          onPressed: _saving ? null : () => unawaited(_save()),
          child: Text(
            _saving ? s.t('saveDeliveryFees') : s.t('saveDeliveryFees'),
          ),
        ),
      ],
    );
  }
}
