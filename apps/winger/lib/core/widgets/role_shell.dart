import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../l10n/winger_strings.dart';
import '../state/app_session.dart';
import '../theme/winger_colors.dart';

class ShellDestination {
  const ShellDestination({
    required this.labelKey,
    required this.icon,
    required this.path,
    this.badgeCount = 0,
  });

  final String labelKey;
  final IconData icon;
  final String path;
  final int badgeCount;
}

class RoleShell extends StatelessWidget {
  const RoleShell({
    super.key,
    required this.title,
    required this.roleLabel,
    required this.destinations,
    required this.child,
    this.bottomBar,
  });

  final String title;
  final String roleLabel;
  final List<ShellDestination> destinations;
  final Widget child;
  /// Reserved bottom slot (not an overlay) so page actions stay visible.
  final Widget? bottomBar;

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final session = context.watch<AppSession>();
    final location = GoRouterState.of(context).uri.path;
    final wide = MediaQuery.sizeOf(context).width >= 980;
    // Prefer the longest matching path so /supplier/products does not
    // highlight Overview (/supplier).
    var index = 0;
    var bestLen = -1;
    for (var i = 0; i < destinations.length; i++) {
      final path = destinations[i].path;
      final match = location == path || location.startsWith('$path/');
      if (match && path.length > bestLen) {
        bestLen = path.length;
        index = i;
      }
    }

    final content = Column(
      children: [
        _TopBar(
          title: title,
          apiOnline: session.apiOnline,
          pendingSyncCount: session.pendingSyncCount,
          onLocale: () => _showLocaleSheet(context),
          onSignOut: () {
            session.signOut();
            context.go('/login');
          },
        ),
        Expanded(child: child),
        // Wide layout has no bottom nav — reserve space in the column.
        if (wide && bottomBar != null) bottomBar!,
      ],
    );

    if (wide) {
      return Scaffold(
        body: Row(
          children: [
            _SideNav(
              roleLabel: roleLabel,
              destinations: destinations,
              selectedIndex: index,
              userName: session.displayName,
              languageLabel: s.languageLabel,
              onSelect: (i) => context.go(destinations[i].path),
            ),
            Expanded(child: content),
          ],
        ),
      );
    }

    return Scaffold(
      body: content,
      bottomNavigationBar: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (bottomBar != null) bottomBar!,
          _PhoneBottomNav(
            destinations: destinations,
            selectedIndex: index.clamp(0, destinations.length - 1),
            onSelect: (i) => context.go(destinations[i].path),
          ),
        ],
      ),
    );
  }

  Future<void> _showLocaleSheet(BuildContext context) async {
    final session = context.read<AppSession>();
    await showModalBottomSheet<void>(
      context: context,
      builder: (ctx) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (final code in LocaleCode.values)
                ListTile(
                  title: Text(switch (code) {
                    LocaleCode.en => 'English',
                    LocaleCode.es => 'Español',
                    LocaleCode.sw => 'Kiswahili',
                  }),
                  trailing: session.localeCode == code
                      ? const Icon(Icons.check, color: WingerColors.brand)
                      : null,
                  onTap: () async {
                    await session.setLocale(code);
                    if (ctx.mounted) Navigator.pop(ctx);
                  },
                ),
            ],
          ),
        );
      },
    );
  }
}

class _PhoneBottomNav extends StatefulWidget {
  const _PhoneBottomNav({
    required this.destinations,
    required this.selectedIndex,
    required this.onSelect,
  });

  final List<ShellDestination> destinations;
  final int selectedIndex;
  final ValueChanged<int> onSelect;

  @override
  State<_PhoneBottomNav> createState() => _PhoneBottomNavState();
}

class _PhoneBottomNavState extends State<_PhoneBottomNav> {
  final _scroll = ScrollController();
  bool _canLeft = false;
  bool _canRight = false;
  List<double> _widths = const [];

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_sync);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _sync();
      _revealSelected();
    });
  }

  @override
  void didUpdateWidget(covariant _PhoneBottomNav oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.selectedIndex != widget.selectedIndex ||
        oldWidget.destinations.length != widget.destinations.length) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _revealSelected());
    }
  }

  @override
  void dispose() {
    _scroll.removeListener(_sync);
    _scroll.dispose();
    super.dispose();
  }

  void _sync() {
    if (!mounted || !_scroll.hasClients) return;
    final pos = _scroll.position;
    final left = pos.pixels > 4;
    final right = pos.maxScrollExtent > 4 && pos.pixels < pos.maxScrollExtent - 4;
    if (left != _canLeft || right != _canRight) {
      setState(() {
        _canLeft = left;
        _canRight = right;
      });
    }
  }

  void _revealSelected() {
    if (!_scroll.hasClients || _widths.isEmpty) return;
    final index = widget.selectedIndex.clamp(0, _widths.length - 1);
    var start = 0.0;
    for (var i = 0; i < index; i++) {
      start += _widths[i];
    }
    final item = _widths[index];
    final view = _scroll.position.viewportDimension;
    final lead = _scroll.offset;
    if (start >= lead && start + item <= lead + view) return;
    final target = (start - (view - item) / 2).clamp(0.0, _scroll.position.maxScrollExtent);
    _scroll.animateTo(
      target,
      duration: const Duration(milliseconds: 280),
      curve: Curves.easeOutCubic,
    );
  }

  Future<void> _move(double delta) async {
    if (!_scroll.hasClients) return;
    final target = (_scroll.offset + delta).clamp(0.0, _scroll.position.maxScrollExtent);
    await _scroll.animateTo(
      target,
      duration: const Duration(milliseconds: 280),
      curve: Curves.easeOutCubic,
    );
    _sync();
  }

  List<double> _measure(BuildContext context) {
    final s = WingerStrings.of(context);
    final style = Theme.of(context).textTheme.labelMedium?.copyWith(
          fontWeight: FontWeight.w600,
          fontSize: 12,
        );
    return [
      for (final destination in widget.destinations)
        math.max(
          72,
          _labelWidth(s.t(destination.labelKey), style, Directionality.of(context)) + 28,
        ),
    ];
  }

  double _labelWidth(String label, TextStyle? style, TextDirection direction) {
    final painter = TextPainter(
      text: TextSpan(text: label, style: style),
      maxLines: 1,
      textDirection: direction,
    )..layout();
    return painter.width;
  }

  Widget _arrow(IconData icon, bool enabled) {
    return IconButton(
      visualDensity: VisualDensity.compact,
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints.tightFor(width: 32, height: 32),
      onPressed: enabled ? () => unawaited(_move(icon == Icons.chevron_left ? -160 : 160)) : null,
      icon: Icon(
        icon,
        size: 22,
        color: enabled ? WingerColors.brand : WingerColors.muted,
      ),
    );
  }

  Widget _item(BuildContext context, int index) {
    final s = WingerStrings.of(context);
    final destination = widget.destinations[index];
    final selected = index == widget.selectedIndex;
    final color = selected ? WingerColors.brand : WingerColors.muted;
    final icon = Icon(destination.icon, color: color);
    return InkWell(
      onTap: () => widget.onSelect(index),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
            decoration: BoxDecoration(
              color: selected ? WingerColors.brandMuted : Colors.transparent,
              borderRadius: BorderRadius.circular(16),
            ),
            child: destination.badgeCount > 0
                ? Badge(label: Text('${destination.badgeCount}'), child: icon)
                : icon,
          ),
          const SizedBox(height: 2),
          Text(
            s.t(destination.labelKey),
            maxLines: 1,
            softWrap: false,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: color,
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Material(
      color: WingerColors.white,
      child: SafeArea(
        top: false,
        child: SizedBox(
          height: 72,
          child: LayoutBuilder(
            builder: (context, constraints) {
              final widths = _measure(context);
              _widths = widths;
              final total = widths.fold<double>(0, (sum, width) => sum + width);
              final scrollable = total > constraints.maxWidth + 0.5;
              if (!scrollable) {
                return Row(
                  children: [
                    for (var i = 0; i < widget.destinations.length; i++)
                      Expanded(child: _item(context, i)),
                  ],
                );
              }
              return Row(
                children: [
                  _arrow(Icons.chevron_left, _canLeft),
                  Expanded(
                    child: ListView.builder(
                      controller: _scroll,
                      scrollDirection: Axis.horizontal,
                      itemCount: widget.destinations.length,
                      itemBuilder: (context, i) => SizedBox(
                        width: widths[i],
                        child: _item(context, i),
                      ),
                    ),
                  ),
                  _arrow(Icons.chevron_right, _canRight),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}

class _TopBar extends StatelessWidget {
  const _TopBar({
    required this.title,
    required this.apiOnline,
    required this.pendingSyncCount,
    required this.onLocale,
    required this.onSignOut,
  });

  final String title;
  final bool apiOnline;
  final int pendingSyncCount;
  final VoidCallback onLocale;
  final VoidCallback onSignOut;

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    return Material(
      color: WingerColors.white,
      child: SafeArea(
        bottom: false,
        child: Container(
          height: 64,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          decoration: const BoxDecoration(
            border: Border(bottom: BorderSide(color: WingerColors.border)),
          ),
          child: Row(
            children: [
              Text(title, style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
              const Spacer(),
              if (pendingSyncCount > 0) ...[
                Container(
                  margin: const EdgeInsets.only(right: 8),
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                  decoration: BoxDecoration(
                    color: WingerColors.info,
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Text(
                    'Sync $pendingSyncCount',
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                      color: WingerColors.infoInk,
                    ),
                  ),
                ),
              ],
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                decoration: BoxDecoration(
                  color: apiOnline ? WingerColors.success : WingerColors.attention,
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Text(
                  '${s.t('apiStatus')}: ${apiOnline ? s.t('online') : s.t('offline')}',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    color: apiOnline ? WingerColors.successInk : WingerColors.attentionInk,
                  ),
                ),
              ),
              IconButton(onPressed: onLocale, icon: const Icon(Icons.language)),
              IconButton(onPressed: onSignOut, icon: const Icon(Icons.logout)),
            ],
          ),
        ),
      ),
    );
  }
}

class _SideNav extends StatelessWidget {
  const _SideNav({
    required this.roleLabel,
    required this.destinations,
    required this.selectedIndex,
    required this.userName,
    required this.languageLabel,
    required this.onSelect,
  });

  final String roleLabel;
  final List<ShellDestination> destinations;
  final int selectedIndex;
  final String userName;
  final String languageLabel;
  final ValueChanged<int> onSelect;

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    return Container(
      width: 260,
      color: WingerColors.brand,
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 24, 20, 8),
              child: Row(
                children: [
                  Container(
                    width: 36,
                    height: 36,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: WingerColors.white.withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: const Text('W', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800)),
                  ),
                  const SizedBox(width: 10),
                  const Expanded(
                    child: Text(
                      'Winger\nONE MARKETPLACE',
                      style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700, height: 1.15),
                    ),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                decoration: BoxDecoration(
                  color: Colors.white.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Text(roleLabel, style: const TextStyle(color: Colors.white70, fontWeight: FontWeight.w600)),
              ),
            ),
            const SizedBox(height: 8),
            Expanded(
              child: ListView.builder(
                itemCount: destinations.length,
                itemBuilder: (context, i) {
                  final d = destinations[i];
                  final selected = i == selectedIndex;
                  return Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
                    child: ListTile(
                      selected: selected,
                      selectedTileColor: Colors.white.withValues(alpha: 0.12),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                      leading: d.badgeCount > 0
                          ? Badge(
                              backgroundColor: WingerColors.attention,
                              textColor: WingerColors.attentionInk,
                              label: Text('${d.badgeCount}'),
                              child: Icon(d.icon, color: Colors.white),
                            )
                          : Icon(d.icon, color: Colors.white),
                      title: Text(
                        s.t(d.labelKey),
                        style: TextStyle(
                          color: Colors.white,
                          fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                        ),
                      ),
                      onTap: () => onSelect(i),
                    ),
                  );
                },
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text(
                '$userName · $languageLabel',
                style: const TextStyle(color: Colors.white70, fontSize: 12),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
