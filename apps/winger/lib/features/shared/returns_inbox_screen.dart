import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/l10n/winger_strings.dart';
import '../../core/models/models.dart';
import '../../core/theme/winger_colors.dart';

class ReturnsInboxScreen extends StatefulWidget {
  const ReturnsInboxScreen({super.key});

  @override
  State<ReturnsInboxScreen> createState() => _ReturnsInboxScreenState();
}

class _ReturnsInboxScreenState extends State<ReturnsInboxScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabs;
  Future<List<OrderReturnRequest>>? _future;
  String? _busyId;

  static const _openStatuses = {'REQUESTED', 'IN_REVIEW'};
  static const _closedStatuses = {'APPROVED', 'REJECTED', 'CLOSED'};

  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 2, vsync: this);
    _tabs.addListener(() {
      if (!_tabs.indexIsChanging) setState(() {});
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _future ??= _load();
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  Future<List<OrderReturnRequest>> _load() {
    return context.read<ApiClient>().fetchReturnsInbox();
  }

  Future<void> _reload() async {
    final next = _load();
    setState(() => _future = next);
    await next;
  }

  List<OrderReturnRequest> _filterRows(List<OrderReturnRequest> all) {
    final wanted = _tabs.index == 0 ? _openStatuses : _closedStatuses;
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
    if (future == null) {
      return const Center(child: CircularProgressIndicator());
    }

    return FutureBuilder<List<OrderReturnRequest>>(
      future: future,
      builder: (context, snapshot) {
        final all = snapshot.data ?? const <OrderReturnRequest>[];
        final openCount =
            all.where((r) => _openStatuses.contains(r.status)).length;
        final closedCount =
            all.where((r) => _closedStatuses.contains(r.status)).length;
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
                    s.t('returnsInboxHint'),
                    style: TextStyle(color: WingerColors.muted),
                  ),
                  const SizedBox(height: 12),
                  TabBar(
                    controller: _tabs,
                    labelColor: WingerColors.brand,
                    unselectedLabelColor: WingerColors.muted,
                    indicatorColor: WingerColors.brand,
                    onTap: (_) => setState(() {}),
                    tabs: [
                      Tab(text: '${s.t('returnsOpen')} ($openCount)'),
                      Tab(text: '${s.t('returnsClosed')} ($closedCount)'),
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
                        _tabs.index == 0
                            ? s.t('returnsOpenEmpty')
                            : s.t('returnsClosedEmpty'),
                        style: TextStyle(color: WingerColors.muted),
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
