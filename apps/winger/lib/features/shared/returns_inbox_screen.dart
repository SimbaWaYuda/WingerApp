import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/l10n/winger_strings.dart';
import '../../core/models/models.dart';
import '../../core/state/app_session.dart';
import '../../core/theme/winger_colors.dart';
import '../../core/widgets/kpi_card.dart';

class ReturnsInboxScreen extends StatefulWidget {
  const ReturnsInboxScreen({super.key});

  @override
  State<ReturnsInboxScreen> createState() => _ReturnsInboxScreenState();
}

class _ReturnsInboxScreenState extends State<ReturnsInboxScreen>
    with SingleTickerProviderStateMixin {
  TabController? _tabs;
  Future<List<OrderReturnRequest>>? _future;
  Map<String, dynamic>? _overview;
  String? _busyId;
  bool _isAdmin = false;
  bool _showOverview = false;

  static const _openStatuses = {'REQUESTED', 'IN_REVIEW'};
  static const _closedStatuses = {'APPROVED', 'REJECTED', 'CLOSED'};

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final role = context.read<AppSession>().role;
    final admin = role == UserRole.admin;
    final showOverview = admin || role == UserRole.supplier;
    if (_tabs == null ||
        _isAdmin != admin ||
        _showOverview != showOverview) {
      _tabs?.dispose();
      _isAdmin = admin;
      _showOverview = showOverview;
      _tabs = TabController(length: showOverview ? 3 : 2, vsync: this);
      _tabs!.addListener(() {
        if (!_tabs!.indexIsChanging) setState(() {});
      });
    }
    _future ??= _load();
    if (showOverview && _overview == null) {
      _loadOverview();
    }
  }

  @override
  void dispose() {
    _tabs?.dispose();
    super.dispose();
  }

  Future<List<OrderReturnRequest>> _load() {
    return context.read<ApiClient>().fetchReturnsInbox();
  }

  Future<void> _loadOverview() async {
    if (!_showOverview) return;
    try {
      final data = await context.read<ApiClient>().fetchReturnsOverview();
      if (!mounted) return;
      setState(() => _overview = data);
    } catch (_) {
      // Inbox still usable without overview.
    }
  }

  Future<void> _reload() async {
    final next = _load();
    setState(() => _future = next);
    await Future.wait([next, _loadOverview()]);
  }

  List<OrderReturnRequest> _filterRows(List<OrderReturnRequest> all) {
    final index = _tabs?.index ?? 0;
    if (_showOverview && index == 2) {
      return all
          .where(
            (row) =>
                row.refundStatus == 'PENDING' &&
                (row.status == 'APPROVED' || row.status == 'CLOSED'),
          )
          .toList();
    }
    final wanted = index == 0 ? _openStatuses : _closedStatuses;
    return all.where((row) => wanted.contains(row.status)).toList();
  }

  String _reasonLabel(WingerStrings s, String reason) {
    switch (reason) {
      case 'damaged':
        return s.t('returnReasonDamaged');
      case 'wrong_item':
        return s.t('returnReasonWrongItem');
      case 'not_as_described':
        return s.t('returnReasonNotAsDescribed');
      case 'changed_mind':
        return s.t('returnReasonChangedMind');
      default:
        return s.t('returnReasonOther');
    }
  }

  String _formatWhen(DateTime when) {
    final local = when.toLocal();
    final y = local.year.toString().padLeft(4, '0');
    final m = local.month.toString().padLeft(2, '0');
    final d = local.day.toString().padLeft(2, '0');
    final hh = local.hour.toString().padLeft(2, '0');
    final mm = local.minute.toString().padLeft(2, '0');
    return '$y-$m-$d $hh:$mm';
  }

  (Color, Color) _statusColors(String status) {
    switch (status) {
      case 'REQUESTED':
        return (WingerColors.attention, WingerColors.attentionInk);
      case 'IN_REVIEW':
        return (WingerColors.info, WingerColors.infoInk);
      case 'APPROVED':
        return (WingerColors.success, WingerColors.successInk);
      case 'REJECTED':
        return (WingerColors.danger, WingerColors.dangerInk);
      default:
        return (WingerColors.muted.withValues(alpha: 0.25), WingerColors.muted);
    }
  }

  Future<bool> _confirmApprove(OrderReturnRequest request) async {
    final s = WingerStrings.of(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(s.t('returnApprove')),
        content: Text(s.t('returnApproveConfirm')),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(s.t('back')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(s.t('returnApprove')),
          ),
        ],
      ),
    );
    return ok == true;
  }

  Future<void> _createReplacement(OrderReturnRequest request) async {
    final s = WingerStrings.of(context);
    final orderId = request.orderId;
    if (orderId == null || orderId.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(s.t('replacementMissingOrder'))),
      );
      return;
    }
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(s.t('createReplacement')),
        content: Text(
          s
              .t('createReplacementConfirm')
              .replaceAll('{product}', request.productName)
              .replaceAll('{id}', orderId),
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

    setState(() => _busyId = request.id);
    try {
      final replacement = await context.read<ApiClient>().createReplacementOrder(
            orderId: orderId,
            itemId: request.orderItemId,
            quantity: request.quantity,
          );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            s.t('replacementCreated').replaceAll('{id}', replacement.id),
          ),
        ),
      );
      await _reload();
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(error.toString().replaceFirst('Exception: ', ''))),
      );
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  String _refundLabel(WingerStrings s, String refundStatus) {
    switch (refundStatus) {
      case 'PENDING':
        return s.t('refundPending');
      case 'ISSUED':
        return s.t('refundIssued');
      case 'NOT_REQUIRED':
        return s.t('refundNotRequired');
      default:
        return s.t('refundNone');
    }
  }

  Future<void> _setStatus(OrderReturnRequest request, String status) async {
    final s = WingerStrings.of(context);
    if (status == 'APPROVED') {
      final confirmed = await _confirmApprove(request);
      if (!confirmed || !mounted) return;
    }

    setState(() => _busyId = request.id);
    try {
      await context.read<ApiClient>().updateReturnRequest(
            returnId: request.id,
            status: status,
          );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(s.t('returnUpdated'))),
      );
      await _reload();
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(error.toString().replaceFirst('Exception: ', ''))),
      );
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  Future<void> _setRefundStatus(
    OrderReturnRequest request,
    String refundStatus,
  ) async {
    final s = WingerStrings.of(context);
    setState(() => _busyId = request.id);
    try {
      await context.read<ApiClient>().updateReturnRequest(
            returnId: request.id,
            refundStatus: refundStatus,
            refundNote: refundStatus == 'ISSUED'
                ? 'Marked issued in supplier returns inbox'
                : refundStatus == 'NOT_REQUIRED'
                    ? 'Marked not required in supplier returns inbox'
                    : null,
          );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(s.t('refundUpdated'))),
      );
      await _reload();
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(error.toString().replaceFirst('Exception: ', ''))),
      );
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final future = _future;
    final tabs = _tabs;
    if (future == null || tabs == null) {
      return const Center(child: CircularProgressIndicator());
    }

    final wide = MediaQuery.sizeOf(context).width >= 900;
    final overview = _overview;
    final platformOpen = (overview?['openReturns'] as num?)?.toInt();
    final platformPendingRefunds =
        (overview?['pendingRefunds'] as num?)?.toInt();
    final platformIssued = (overview?['refundsIssued'] as num?)?.toInt();
    final platformRejected = (overview?['rejectedReturns'] as num?)?.toInt();
    final suppliers = (overview?['suppliers'] as List<dynamic>? ?? const [])
        .whereType<Map>()
        .map((raw) => Map<String, dynamic>.from(raw))
        .toList();

    return FutureBuilder<List<OrderReturnRequest>>(
      future: future,
      builder: (context, snapshot) {
        final all = snapshot.data ?? const <OrderReturnRequest>[];
        final openCount =
            all.where((r) => _openStatuses.contains(r.status)).length;
        final closedCount =
            all.where((r) => _closedStatuses.contains(r.status)).length;
        final pendingRefundCount = all
            .where(
              (r) =>
                  r.refundStatus == 'PENDING' &&
                  (r.status == 'APPROVED' || r.status == 'CLOSED'),
            )
            .length;
        final rows = _filterRows(all);

        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 20, 20, 0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    s.t('returns'),
                    style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _isAdmin
                        ? s.t('returnsAdminOverviewHint')
                        : _showOverview
                            ? s.t('returnsSupplierOverviewHint')
                            : s.t('returnsInboxHint'),
                    style: const TextStyle(color: WingerColors.muted),
                  ),
                  if (_showOverview) ...[
                    const SizedBox(height: 12),
                    GridView.count(
                      shrinkWrap: true,
                      physics: const NeverScrollableScrollPhysics(),
                      crossAxisCount: wide ? 4 : 2,
                      mainAxisSpacing: 10,
                      crossAxisSpacing: 10,
                      childAspectRatio: wide ? 1.55 : 1.35,
                      children: [
                        KpiCard(
                          data: KpiCardData(
                            label: s.t('returnsOpen'),
                            value: '${platformOpen ?? openCount}',
                            delta: s.t('needsReview'),
                            positive: (platformOpen ?? openCount) == 0,
                          ),
                          onTap: () => tabs.animateTo(0),
                        ),
                        KpiCard(
                          data: KpiCardData(
                            label: s.t('refundsPending'),
                            value:
                                '${platformPendingRefunds ?? pendingRefundCount}',
                            delta: s.t('awaitingRefund'),
                            positive:
                                (platformPendingRefunds ?? pendingRefundCount) ==
                                    0,
                          ),
                          onTap: () => tabs.animateTo(2),
                        ),
                        KpiCard(
                          data: KpiCardData(
                            label: s.t('refundsIssued'),
                            value: '${platformIssued ?? 0}',
                            delta: s.t('markedIssued'),
                            positive: true,
                          ),
                        ),
                        KpiCard(
                          data: KpiCardData(
                            label: s.t('returnsRejected'),
                            value: '${platformRejected ?? 0}',
                            delta: s.t('returnsClosed'),
                            positive: true,
                          ),
                          onTap: () => tabs.animateTo(1),
                        ),
                      ],
                    ),
                    if (_isAdmin && suppliers.isNotEmpty) ...[
                      const SizedBox(height: 12),
                      Text(
                        s.t('returnsBySupplier'),
                        style: const TextStyle(fontWeight: FontWeight.w800),
                      ),
                      const SizedBox(height: 6),
                      for (final row in suppliers.take(6))
                        Padding(
                          padding: const EdgeInsets.only(bottom: 4),
                          child: Text(
                            '${row['supplierName'] ?? 'Supplier'} · '
                            '${s.t('returnsOpen')} ${(row['openReturns'] as num?)?.toInt() ?? 0} · '
                            '${s.t('refundsPending')} ${(row['pendingRefunds'] as num?)?.toInt() ?? 0}',
                            style: const TextStyle(color: WingerColors.muted),
                          ),
                        ),
                    ],
                  ],
                  const SizedBox(height: 12),
                  TabBar(
                    controller: tabs,
                    labelColor: WingerColors.brand,
                    unselectedLabelColor: WingerColors.muted,
                    indicatorColor: WingerColors.brand,
                    onTap: (_) => setState(() {}),
                    tabs: [
                      Tab(text: '${s.t('returnsOpen')} ($openCount)'),
                      Tab(text: '${s.t('returnsClosed')} ($closedCount)'),
                      if (_showOverview)
                        Tab(
                          text:
                              '${s.t('refundsPending')} ($pendingRefundCount)',
                        ),
                    ],
                  ),
                ],
              ),
            ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _reload,
                child: ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.all(20),
                  children: [
                    if (snapshot.connectionState != ConnectionState.done)
                      const Padding(
                        padding: EdgeInsets.only(top: 40),
                        child: Center(child: CircularProgressIndicator()),
                      )
                    else if (snapshot.hasError)
                      Text(
                        snapshot.error
                            .toString()
                            .replaceFirst('Exception: ', ''),
                        style: const TextStyle(color: WingerColors.dangerInk),
                      )
                    else if (rows.isEmpty)
                      Text(
                        tabs.index == 0
                            ? s.t('returnsOpenEmpty')
                            : tabs.index == 2
                                ? s.t('refundsPendingEmpty')
                                : s.t('returnsClosedEmpty'),
                        style: const TextStyle(color: WingerColors.muted),
                      )
                    else
                      for (final request in rows)
                        Card(
                          child: Padding(
                            padding: const EdgeInsets.all(14),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    Expanded(
                                      child: Text(
                                        request.productName,
                                        style: const TextStyle(
                                          fontWeight: FontWeight.w800,
                                        ),
                                      ),
                                    ),
                                    _ReturnStatusChip(
                                      status: request.status,
                                      colors: _statusColors(request.status),
                                    ),
                                  ],
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  [
                                    if (request.orderId != null) request.orderId!,
                                    if (request.customerName != null)
                                      request.customerName!,
                                    request.supplierName,
                                    'qty ${request.quantity}',
                                  ].join(' · '),
                                ),
                                Text(_reasonLabel(s, request.reason)),
                                Text(
                                  _formatWhen(request.createdAt),
                                  style: TextStyle(
                                    color: WingerColors.muted,
                                    fontSize: 12,
                                  ),
                                ),
                                Text(
                                  '${s.t('refundStatus')}: ${_refundLabel(s, request.refundStatus)}',
                                  style: TextStyle(
                                    color: request.refundStatus == 'PENDING'
                                        ? WingerColors.attentionInk
                                        : WingerColors.muted,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                                if (request.refundNote != null &&
                                    request.refundNote!.isNotEmpty)
                                  Text(
                                    request.refundNote!,
                                    style: TextStyle(color: WingerColors.muted),
                                  ),
                                if (request.notes != null &&
                                    request.notes!.isNotEmpty)
                                  Text(
                                    request.notes!,
                                    style: TextStyle(color: WingerColors.muted),
                                  ),
                                if (request.canReview) ...[
                                  const SizedBox(height: 10),
                                  Wrap(
                                    spacing: 8,
                                    runSpacing: 8,
                                    children: [
                                      if (request.status == 'REQUESTED')
                                        OutlinedButton(
                                          onPressed: _busyId == request.id
                                              ? null
                                              : () => _setStatus(
                                                    request,
                                                    'IN_REVIEW',
                                                  ),
                                          child: Text(s.t('returnMarkReview')),
                                        ),
                                      FilledButton(
                                        onPressed: _busyId == request.id
                                            ? null
                                            : () => _setStatus(
                                                  request,
                                                  'APPROVED',
                                                ),
                                        child: Text(s.t('returnApprove')),
                                      ),
                                      OutlinedButton(
                                        onPressed: _busyId == request.id
                                            ? null
                                            : () => _setStatus(
                                                  request,
                                                  'REJECTED',
                                                ),
                                        child: Text(s.t('returnReject')),
                                      ),
                                    ],
                                  ),
                                ] else if (request.status == 'APPROVED') ...[
                                  const SizedBox(height: 10),
                                  Wrap(
                                    spacing: 8,
                                    runSpacing: 8,
                                    children: [
                                      FilledButton(
                                        onPressed: _busyId == request.id
                                            ? null
                                            : () =>
                                                _createReplacement(request),
                                        child: Text(s.t('createReplacement')),
                                      ),
                                      if (request.canManageRefund) ...[
                                        OutlinedButton(
                                          onPressed: _busyId == request.id
                                              ? null
                                              : () => _setRefundStatus(
                                                    request,
                                                    'ISSUED',
                                                  ),
                                          child: Text(s.t('markRefundIssued')),
                                        ),
                                        OutlinedButton(
                                          onPressed: _busyId == request.id
                                              ? null
                                              : () => _setRefundStatus(
                                                    request,
                                                    'NOT_REQUIRED',
                                                  ),
                                          child: Text(s.t('markRefundNotRequired')),
                                        ),
                                      ],
                                      TextButton(
                                        onPressed: _busyId == request.id
                                            ? null
                                            : () =>
                                                _setStatus(request, 'CLOSED'),
                                        child: Text(s.t('returnClose')),
                                      ),
                                    ],
                                  ),
                                ] else if (request.status == 'REJECTED') ...[
                                  const SizedBox(height: 10),
                                  TextButton(
                                    onPressed: _busyId == request.id
                                        ? null
                                        : () =>
                                            _setStatus(request, 'CLOSED'),
                                    child: Text(s.t('returnClose')),
                                  ),
                                ],
                              ],
                            ),
                          ),
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

class _ReturnStatusChip extends StatelessWidget {
  const _ReturnStatusChip({required this.status, required this.colors});

  final String status;
  final (Color, Color) colors;

  @override
  Widget build(BuildContext context) {
    final (bg, fg) = colors;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(
        status,
        style: TextStyle(
          color: fg,
          fontSize: 11,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.4,
        ),
      ),
    );
  }
}
