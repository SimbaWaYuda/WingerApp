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
  });

  final String labelKey;
  final IconData icon;
  final String path;
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
    final location = GoRouterState.of(context).uri.toString();
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
          NavigationBar(
            selectedIndex: index.clamp(0, destinations.length - 1),
            onDestinationSelected: (i) => context.go(destinations[i].path),
            destinations: destinations
                .map(
                  (d) => NavigationDestination(
                    icon: Icon(d.icon),
                    label: s.t(d.labelKey),
                  ),
                )
                .toList(),
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
                      leading: Icon(d.icon, color: Colors.white),
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
