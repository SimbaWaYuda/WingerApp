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

  static const _openStatuses = 'REQUESTED,IN_REVIEW';
  static const _closedStatuses = 'APPROVED,REJECTED,CLOSED';

  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 2, vsync: this);
    _tabs.addListener(() {
      if (_tabs.indexIsChanging) return;
      setState(() => _future = _load());
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

  String get _statusFilter =>
      _tabs.index == 0 ? _openStatuses : _closedStatuses;

  Future<List<OrderReturnRequest>> _load() {
    return context.read<ApiClient>().fetchReturnsInbox(status: _statusFilter);
  }

  Future<void> _reload() async {
    final next = _load();
    setState(() => _future = next);
    await next;
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

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final future = _future;
    if (future == null) {
      return const Center(child: CircularProgressIndicator());
    }

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
                tabs: [
                  Tab(text: s.t('returnsOpen')),
                  Tab(text: s.t('returnsClosed')),
                ],
              ),
            ],
          ),
        ),
        Expanded(
          child: FutureBuilder<List<OrderReturnRequest>>(
            future: future,
            builder: (context, snapshot) {
              final rows = snapshot.data ?? const <OrderReturnRequest>[];
              return RefreshIndicator(
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
                        s.t('returnsEmpty'),
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
                                ] else if (request.status == 'APPROVED' ||
                                    request.status == 'REJECTED') ...[
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
              );
            },
          ),
        ),
      ],
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
