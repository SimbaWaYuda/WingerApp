import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../api/api_client.dart';
import '../l10n/winger_strings.dart';
import '../state/app_session.dart';
import '../theme/winger_colors.dart';
import '../theme/winger_tokens.dart';
import 'winger_logo.dart';

/// How the shell should compose chrome on wide layouts.
enum ShellLayoutKind {
  /// Customer marketplace — top nav on web, side nav on native desktop.
  customerMarketplace,

  /// Supplier/admin operations — side nav when wide.
  operations,
}

class ShellDestination {
  const ShellDestination({
    required this.labelKey,
    required this.icon,
    required this.path,
    this.badgeCount = 0,
    this.alsoMatchingPrefixes = const [],
  });

  final String labelKey;
  final IconData icon;
  final String path;
  final int badgeCount;

  /// Extra path prefixes that keep this destination selected.
  final List<String> alsoMatchingPrefixes;
}

/// Longest-prefix destination selection (exported for tests).
int selectedShellDestinationIndex(
  String location,
  List<ShellDestination> destinations,
) {
  var index = 0;
  var bestLen = -1;
  for (var i = 0; i < destinations.length; i++) {
    final paths = <String>[
      destinations[i].path,
      ...destinations[i].alsoMatchingPrefixes,
    ];
    for (final path in paths) {
      final match = location == path || location.startsWith('$path/');
      if (match && path.length > bestLen) {
        bestLen = path.length;
        index = i;
      }
    }
  }
  return index;
}

/// Resolves bottom / side / marketplace-top chrome (exported for tests).
enum ShellChrome { bottom, side, marketplaceTop }

ShellChrome resolveShellChrome({
  required double width,
  required ShellLayoutKind layoutKind,
}) {
  if (!WingerBreakpoints.isWideShell(width)) {
    return ShellChrome.bottom;
  }
  if (layoutKind == ShellLayoutKind.customerMarketplace && kIsWeb) {
    return ShellChrome.marketplaceTop;
  }
  return ShellChrome.side;
}

class RoleShell extends StatelessWidget {
  const RoleShell({
    super.key,
    required this.title,
    required this.roleLabel,
    required this.destinations,
    required this.child,
    this.bottomBar,
    this.layoutKind = ShellLayoutKind.operations,
    this.mobileDestinations,
    this.showMarketplaceCategories = false,
  });

  final String title;
  final String roleLabel;
  final List<ShellDestination> destinations;

  /// Optional compact-only destinations (e.g. supplier More grouping).
  /// When null, [destinations] is used for every chrome mode.
  final List<ShellDestination>? mobileDestinations;
  final Widget child;
  final Widget? bottomBar;
  final ShellLayoutKind layoutKind;
  final bool showMarketplaceCategories;

  List<ShellDestination> _destinationsFor(ShellChrome chrome) {
    if (chrome == ShellChrome.bottom && mobileDestinations != null) {
      return mobileDestinations!;
    }
    return destinations;
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final session = context.watch<AppSession>();
    final width = MediaQuery.sizeOf(context).width;
    final chrome = resolveShellChrome(width: width, layoutKind: layoutKind);
    final navDestinations = _destinationsFor(chrome);
    final location = GoRouterState.of(context).uri.path;
    final index = selectedShellDestinationIndex(location, navDestinations)
        .clamp(0, navDestinations.isEmpty ? 0 : navDestinations.length - 1);

    Future<void> showLocale() => _showLocaleSheet(context);

    if (chrome == ShellChrome.marketplaceTop) {
      return Scaffold(
        body: Column(
          children: [
            _MarketplaceTopBar(
              apiOnline: session.apiOnline,
              pendingSyncCount: session.pendingSyncCount,
              cartCount: session.cartCount,
              onLocale: showLocale,
              onSignOut: () {
                unawaited(session.signOut());
                context.go('/login');
              },
              showCategories: showMarketplaceCategories,
            ),
            Expanded(child: child),
            if (bottomBar != null) bottomBar!,
          ],
        ),
      );
    }

    final content = Column(
      children: [
        _TopBar(
          title: title,
          apiOnline: session.apiOnline,
          pendingSyncCount: session.pendingSyncCount,
          onLocale: showLocale,
          onSignOut: () {
            unawaited(session.signOut());
            context.go('/login');
          },
          showMenu: chrome == ShellChrome.bottom && navDestinations.length > 5,
          destinations: navDestinations,
          selectedIndex: index,
        ),
        Expanded(child: child),
        if (chrome == ShellChrome.side && bottomBar != null) bottomBar!,
      ],
    );

    if (chrome == ShellChrome.side) {
      return Scaffold(
        body: Row(
          children: [
            _SideNav(
              roleLabel: roleLabel,
              destinations: navDestinations,
              selectedIndex: index,
              userName: session.browsingAsGuest
                  ? s.t('guestShopper')
                  : session.displayName,
              languageLabel: s.languageLabel,
              onSelect: (i) => context.go(navDestinations[i].path),
              onLocale: showLocale,
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
          if (navDestinations.length <= 5)
            _FixedBottomNav(
              destinations: navDestinations,
              selectedIndex: index,
              onSelect: (i) => context.go(navDestinations[i].path),
            ),
        ],
      ),
    );
  }
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
                    ? const Icon(Icons.check, color: WingerColors.brandPrimary)
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

class _FixedBottomNav extends StatelessWidget {
  const _FixedBottomNav({
    required this.destinations,
    required this.selectedIndex,
    required this.onSelect,
  });

  final List<ShellDestination> destinations;
  final int selectedIndex;
  final ValueChanged<int> onSelect;

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    return Material(
      key: const ValueKey('role-shell-bottom-nav'),
      color: WingerColors.bgElevated,
      elevation: WingerElevation.materialLevel1,
      child: SafeArea(
        top: false,
        child: SizedBox(
          height: 64,
          child: Row(
            children: [
              for (var i = 0; i < destinations.length; i++)
                Expanded(
                  child: _BottomNavItem(
                    destination: destinations[i],
                    label: s.t(destinations[i].labelKey),
                    selected: i == selectedIndex,
                    onTap: () => onSelect(i),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _BottomNavItem extends StatelessWidget {
  const _BottomNavItem({
    required this.destination,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final ShellDestination destination;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = selected ? WingerColors.brandPrimary : WingerColors.inkMuted;
    final icon = Icon(destination.icon, color: color, size: 24);
    // excludeSemantics: one accessible name (avoids "Overview Overview" from
    // Semantics.label + child Text) while keeping a single selected flag.
    return Semantics(
      button: true,
      selected: selected,
      label: label,
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        focusColor: WingerColors.focusRing.withValues(alpha: 0.12),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                decoration: BoxDecoration(
                  color: selected ? WingerColors.brandMuted : Colors.transparent,
                  borderRadius: BorderRadius.circular(WingerRadius.chip),
                ),
                child: destination.badgeCount > 0
                    ? Badge(
                        label: Text('${destination.badgeCount}'),
                        child: icon,
                      )
                    : icon,
              ),
              const SizedBox(height: 2),
              Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                  color: color,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _MarketplaceTopBar extends StatelessWidget {
  const _MarketplaceTopBar({
    required this.apiOnline,
    required this.pendingSyncCount,
    required this.cartCount,
    required this.onLocale,
    required this.onSignOut,
    required this.showCategories,
  });

  final bool apiOnline;
  final int pendingSyncCount;
  final int cartCount;
  final VoidCallback onLocale;
  final VoidCallback onSignOut;
  final bool showCategories;

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final session = context.watch<AppSession>();
    return Material(
      color: WingerColors.bgElevated,
      elevation: WingerElevation.materialLevel1,
      child: SafeArea(
        bottom: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(
                WingerSpacing.s16,
                WingerSpacing.s8,
                WingerSpacing.s16,
                WingerSpacing.s8,
              ),
              child: Row(
                children: [
                  InkWell(
                    onTap: () => context.go('/customer'),
                    borderRadius: BorderRadius.circular(WingerRadius.controlCompact),
                    focusColor: WingerColors.focusRing.withValues(alpha: 0.12),
                    child: const Padding(
                      padding: EdgeInsets.all(4),
                      child: WingerLogo(size: 36),
                    ),
                  ),
                  const SizedBox(width: WingerSpacing.s16),
                  Expanded(
                    child: Semantics(
                      textField: true,
                      label: s.t('search'),
                      child: TextField(
                        readOnly: true,
                        onTap: () => context.go('/customer/search'),
                        decoration: InputDecoration(
                          hintText: s.t('search'),
                          prefixIcon: const Icon(Icons.search),
                          isDense: true,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: WingerSpacing.s8),
                  _CurrencyIconButton(),
                  IconButton(
                    tooltip: s.languageLabel,
                    onPressed: onLocale,
                    icon: const Icon(Icons.language),
                  ),
                  IconButton(
                    tooltip: session.browsingAsGuest
                        ? s.t('guestShopper')
                        : s.t('account'),
                    onPressed: () => context.go('/customer/account'),
                    icon: const Icon(Icons.person_outline),
                  ),
                  IconButton(
                    tooltip: s.t('cart'),
                    onPressed: () => context.go('/customer/cart'),
                    icon: cartCount > 0
                        ? Badge(
                            label: Text('$cartCount'),
                            child: const Icon(Icons.shopping_cart_outlined),
                          )
                        : const Icon(Icons.shopping_cart_outlined),
                  ),
                  IconButton(
                    tooltip: s.t('signOut'),
                    onPressed: onSignOut,
                    icon: const Icon(Icons.logout),
                  ),
                ],
              ),
            ),
            if (showCategories)
              SizedBox(
                height: 40,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(horizontal: WingerSpacing.s16),
                  children: [
                    TextButton(
                      onPressed: () => context.go('/customer/search'),
                      child: Text(s.t('allCategories')),
                    ),
                    TextButton(
                      onPressed: () => context.go('/customer/search'),
                      child: Text(s.t('featuredProducts')),
                    ),
                    TextButton(
                      onPressed: () => context.go('/customer/wishlist'),
                      child: Text(s.t('wishlist')),
                    ),
                  ],
                ),
              ),
            if (pendingSyncCount > 0 || !apiOnline)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Text(
                  !apiOnline
                      ? '${s.t('apiStatus')}: ${s.t('offline')}'
                      : '${s.t('apiStatus')}: ${s.t('online')}',
                  style: TextStyle(
                    fontSize: 12,
                    color: apiOnline
                        ? WingerColors.successInk
                        : WingerColors.attentionInk,
                  ),
                ),
              ),
            const Divider(height: 1),
          ],
        ),
      ),
    );
  }
}

class _CurrencyIconButton extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final session = context.watch<AppSession>();
    final api = context.read<ApiClient>();
    final s = WingerStrings.of(context);
    final options = session.supportedDisplayCurrencies;
    final selected = options.contains(session.displayCurrency)
        ? session.displayCurrency
        : session.settlementCurrency;
    return PopupMenuButton<String>(
      tooltip: s.t('displayCurrency'),
      initialValue: selected,
      onSelected: (value) async {
        try {
          await api.setDisplayCurrency(value);
        } catch (_) {
          // Preserve existing home behaviour: errors surface via snackbars there.
        }
      },
      itemBuilder: (context) => [
        for (final code in options)
          PopupMenuItem(value: code, child: Text(code)),
      ],
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.payments_outlined, size: 20),
            const SizedBox(width: 4),
            Text(
              selected,
              style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13),
            ),
          ],
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
    required this.showMenu,
    required this.destinations,
    required this.selectedIndex,
  });

  final String title;
  final bool apiOnline;
  final int pendingSyncCount;
  final VoidCallback onLocale;
  final VoidCallback onSignOut;
  final bool showMenu;
  final List<ShellDestination> destinations;
  final int selectedIndex;

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    return Material(
      color: WingerColors.bgElevated,
      child: SafeArea(
        bottom: false,
        child: Container(
          height: 64,
          padding: const EdgeInsets.symmetric(horizontal: WingerSpacing.s16),
          decoration: const BoxDecoration(
            border: Border(bottom: BorderSide(color: WingerColors.borderDefault)),
          ),
          child: Row(
            children: [
              if (showMenu)
                PopupMenuButton<int>(
                  tooltip: s.t('more'),
                  onSelected: (i) => context.go(destinations[i].path),
                  itemBuilder: (context) => [
                    for (var i = 0; i < destinations.length; i++)
                      CheckedPopupMenuItem<int>(
                        value: i,
                        checked: i == selectedIndex,
                        child: Text(s.t(destinations[i].labelKey)),
                      ),
                  ],
                  child: const Padding(
                    padding: EdgeInsets.only(right: 8),
                    child: Icon(Icons.menu),
                  ),
                ),
              Expanded(
                child: Text(
                  title,
                  style: Theme.of(context).textTheme.titleLarge,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (pendingSyncCount > 0) ...[
                Semantics(
                  label:
                      '${s.t('pendingSyncHint')} ($pendingSyncCount)',
                  child: Tooltip(
                    message: s.t('pendingSyncHint'),
                    child: Container(
                      margin: const EdgeInsets.only(right: 8),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 6,
                      ),
                      decoration: BoxDecoration(
                        color: WingerColors.info,
                        borderRadius:
                            BorderRadius.circular(WingerRadius.chip),
                      ),
                      child: Text(
                        '${s.t('pendingSync')} · $pendingSyncCount',
                        style: const TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w700,
                          color: WingerColors.infoInk,
                        ),
                      ),
                    ),
                  ),
                ),
              ],
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                decoration: BoxDecoration(
                  color: apiOnline
                      ? WingerColors.success
                      : WingerColors.attention,
                  borderRadius: BorderRadius.circular(WingerRadius.chip),
                ),
                child: Text(
                  '${s.t('apiStatus')}: ${apiOnline ? s.t('online') : s.t('offline')}',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    color: apiOnline
                        ? WingerColors.successInk
                        : WingerColors.attentionInk,
                  ),
                ),
              ),
              IconButton(
                tooltip: s.languageLabel,
                onPressed: onLocale,
                icon: const Icon(Icons.language),
              ),
              IconButton(
                tooltip: s.t('signOut'),
                onPressed: onSignOut,
                icon: const Icon(Icons.logout),
              ),
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
    required this.onLocale,
  });

  final String roleLabel;
  final List<ShellDestination> destinations;
  final int selectedIndex;
  final String userName;
  final String languageLabel;
  final ValueChanged<int> onSelect;
  final VoidCallback onLocale;

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    return Shortcuts(
      shortcuts: const {
        SingleActivator(LogicalKeyboardKey.arrowDown):
            _MoveDestinationIntent(1),
        SingleActivator(LogicalKeyboardKey.arrowUp):
            _MoveDestinationIntent(-1),
      },
      child: Actions(
        actions: {
          _MoveDestinationIntent: CallbackAction<_MoveDestinationIntent>(
            onInvoke: (intent) {
              if (destinations.isEmpty) return null;
              final next = (selectedIndex + intent.delta)
                  .clamp(0, destinations.length - 1);
              onSelect(next);
              return null;
            },
          ),
        },
        child: FocusTraversalGroup(
          child: Container(
            width: 260,
            color: WingerColors.brandPrimary,
            child: SafeArea(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 24, 20, 8),
                    child: Row(
                      children: [
                        Container(
                          width: 40,
                          height: 40,
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            color: WingerColors.bgSurface.withValues(alpha: 0.15),
                            borderRadius: BorderRadius.circular(
                              WingerRadius.controlCompact,
                            ),
                          ),
                          child: Text(
                            'W',
                            style: TextStyle(
                              color: WingerColors.bgSurface,
                              fontWeight: FontWeight.w800,
                              fontSize: 18,
                            ),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            '${s.t('appName')}\n${s.t('tagline').toUpperCase()}',
                            style: const TextStyle(
                              color: Colors.white,
                              fontWeight: FontWeight.w700,
                              height: 1.15,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  Padding(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 6,
                      ),
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.12),
                        borderRadius: BorderRadius.circular(WingerRadius.chip),
                      ),
                      child: Text(
                        roleLabel,
                        style: const TextStyle(
                          color: Colors.white70,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
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
                          padding: const EdgeInsets.symmetric(
                            horizontal: 12,
                            vertical: 2,
                          ),
                          child: ListTile(
                            autofocus: selected,
                            selected: selected,
                            selectedTileColor:
                                Colors.white.withValues(alpha: 0.12),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(
                                WingerRadius.cardCompact,
                              ),
                            ),
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
                                fontWeight: selected
                                    ? FontWeight.w700
                                    : FontWeight.w500,
                              ),
                            ),
                            onTap: () => onSelect(i),
                          ),
                        );
                      },
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.all(WingerSpacing.s16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '$userName · $languageLabel',
                          style: const TextStyle(
                            color: Colors.white70,
                            fontSize: 12,
                          ),
                        ),
                        TextButton(
                          onPressed: onLocale,
                          style: TextButton.styleFrom(
                            foregroundColor: Colors.white,
                          ),
                          child: Text(s.languageLabel),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _MoveDestinationIntent extends Intent {
  const _MoveDestinationIntent(this.delta);
  final int delta;
}
