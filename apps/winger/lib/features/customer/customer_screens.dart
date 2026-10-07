import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/data/mock_catalog.dart';
import '../../core/l10n/winger_strings.dart';
import '../../core/models/models.dart';
import '../../core/repositories/catalog_repository.dart';
import '../../core/state/app_session.dart';
import '../../core/theme/winger_colors.dart';
import '../../core/widgets/product_card.dart';
import '../../core/widgets/product_photo.dart';
import '../../core/widgets/role_shell.dart';
import '../../core/widgets/status_badge.dart';
import '../onboarding/onboarding_checklist.dart';

List<ShellDestination> customerDestinations({int unreadNotifications = 0}) => [
  const ShellDestination(labelKey: 'home', icon: Icons.home_outlined, path: '/customer'),
  const ShellDestination(labelKey: 'search', icon: Icons.search, path: '/customer/search'),
  const ShellDestination(labelKey: 'orders', icon: Icons.receipt_long_outlined, path: '/customer/orders'),
  ShellDestination(
    labelKey: 'account',
    icon: Icons.person_outline,
    path: '/customer/account',
    badgeCount: unreadNotifications,
  ),
];

class CustomerShell extends StatefulWidget {
  const CustomerShell({super.key, required this.child});

  final Widget child;

  @override
  State<CustomerShell> createState() => _CustomerShellState();
}

class _CustomerShellState extends State<CustomerShell> {
  int _unreadNotifications = 0;
  String? _lastPath;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _refreshUnread());
  }

  Future<void> _refreshUnread() async {
    if (!mounted) return;
    final session = context.read<AppSession>();
    final api = context.read<ApiClient>();
    if (session.accessToken == null || !session.apiOnline) {
      if (_unreadNotifications != 0) setState(() => _unreadNotifications = 0);
      return;
    }
    try {
      final next = await api.fetchNotificationUnreadCount();
      if (!mounted) return;
      if (next != _unreadNotifications) {
        setState(() => _unreadNotifications = next);
      }
    } catch (_) {
      // Keep last known badge count offline.
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final session = context.watch<AppSession>();
    final location = GoRouterState.of(context).uri.path;
    if (_lastPath != location) {
      _lastPath = location;
      WidgetsBinding.instance.addPostFrameCallback((_) => _refreshUnread());
    }
    final onCompare = location.startsWith('/customer/compare');
    final showTray = session.compareIds.isNotEmpty && !onCompare;

    return RoleShell(
      title: s.t('home'),
      roleLabel: 'Customer',
      destinations: customerDestinations(unreadNotifications: _unreadNotifications),
      bottomBar: showTray
          ? _CompareTray(
              count: session.compareIds.length,
              onClear: session.clearCompare,
              onCompare: () => context.go('/customer/compare'),
            )
          : null,
      child: widget.child,
    );
  }
}

Future<void> _showAddedToCartChoices(BuildContext context, {String? productName}) async {
  final s = WingerStrings.of(context);
  final choice = await showDialog<String>(
    context: context,
    builder: (ctx) {
      return AlertDialog(
        title: Text(s.t('addedToCart')),
        content: Text(
          productName == null || productName.isEmpty
              ? s.t('addedToCart')
              : productName,
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop('continue'),
            child: Text(s.t('continueShopping')),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop('checkout'),
            child: Text(s.t('checkout')),
          ),
        ],
      );
    },
  );
  if (!context.mounted) return;
  if (choice == 'checkout') {
    context.go('/customer/checkout');
  } else if (choice == 'continue') {
    context.go('/customer');
  }
}

class _CompareTray extends StatelessWidget {
  const _CompareTray({
    required this.count,
    required this.onClear,
    required this.onCompare,
  });

  final int count;
  final VoidCallback onClear;
  final VoidCallback onCompare;

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    return Material(
      color: WingerColors.brand,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  'Comparing $count products',
                  style: const TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              TextButton(
                onPressed: onClear,
                style: TextButton.styleFrom(foregroundColor: Colors.white70),
                child: Text(s.t('clearFilters')),
              ),
              const SizedBox(width: 4),
              FilledButton(
                onPressed: onCompare,
                style: FilledButton.styleFrom(
                  backgroundColor: Colors.white,
                  foregroundColor: WingerColors.brand,
                ),
                child: Text(s.t('compare')),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class CustomerHomeScreen extends StatefulWidget {
  const CustomerHomeScreen({super.key});

  @override
  State<CustomerHomeScreen> createState() => _CustomerHomeScreenState();
}

class _CustomerHomeScreenState extends State<CustomerHomeScreen> {
  late Future<List<Product>> _products;
  late Future<List<CatalogCategory>> _categories;

  @override
  void initState() {
    super.initState();
    final catalog = context.read<CatalogRepository>();
    _products = catalog.getProducts();
    _categories = catalog.getCategories();
    _stampBrowse();
  }

  Future<void> _stampBrowse() async {
    final session = context.read<AppSession>();
    final api = context.read<ApiClient>();
    if (session.accessToken == null) return;
    try {
      await api.stampOnboardingActivity('browsed_catalog');
    } catch (_) {}
  }

  List<Product> _byIds(List<Product> all, List<String> ids) {
    final map = {for (final p in all) p.id: p};
    return [for (final id in ids) if (map[id] != null) map[id]!];
  }

  Widget _productStrip({
    required List<Product> products,
    required bool wide,
    required AppSession session,
  }) {
    if (products.isEmpty) {
      return Text('—', style: TextStyle(color: WingerColors.muted));
    }
    return _HomeProductCarousel(
      products: products,
      wide: wide,
      session: session,
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final session = context.watch<AppSession>();
    final wide = MediaQuery.sizeOf(context).width >= 900;

    return FutureBuilder(
      future: Future.wait([_products, _categories]),
      builder: (context, snapshot) {
        final products = snapshot.data != null
            ? snapshot.data![0] as List<Product>
            : MockCatalog.products;
        final categories = snapshot.data != null
            ? snapshot.data![1] as List<CatalogCategory>
            : <CatalogCategory>[];
        final featured = [...products]..sort((a, b) => b.rating.compareTo(a.rating));
        final deals = products
            .where((p) => p.previousPrice != null && p.previousPrice! > p.price)
            .toList();
        final recent = _byIds(products, session.recentlyViewedIds);
        final wishlisted = _byIds(products, session.wishlistIds);

        return ListView(
          padding: const EdgeInsets.all(20),
          children: [
            const OnboardingChecklistCard(journeyRoute: '/customer/onboarding'),
            Container(
              padding: EdgeInsets.all(wide ? 32 : 20),
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: [WingerColors.brand, WingerColors.brand.withValues(alpha: 0.85)],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(24),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Winger',
                    style: Theme.of(context).textTheme.headlineLarge?.copyWith(
                          color: Colors.white,
                          fontWeight: FontWeight.w900,
                        ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    s.t('heroTitle'),
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                          color: Colors.white.withValues(alpha: 0.92),
                          fontWeight: FontWeight.w600,
                        ),
                  ),
                  const SizedBox(height: 16),
                  FilledButton(
                    style: FilledButton.styleFrom(
                      backgroundColor: WingerColors.attention,
                      foregroundColor: WingerColors.attentionInk,
                    ),
                    onPressed: () => context.go('/customer/search'),
                    child: Text(s.t('explore')),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            TextField(
              readOnly: true,
              onTap: () => context.go('/customer/search'),
              decoration: InputDecoration(
                hintText: s.t('searchHint'),
                prefixIcon: const Icon(Icons.search),
                suffixIcon: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    IconButton(
                      onPressed: () => context.go('/customer/wishlist'),
                      icon: Badge(
                        isLabelVisible: session.wishlistIds.isNotEmpty,
                        label: Text('${session.wishlistIds.length}'),
                        child: const Icon(Icons.favorite_border),
                      ),
                    ),
                    IconButton(
                      onPressed: () => context.go('/customer/cart'),
                      icon: Badge(
                        isLabelVisible: session.cartCount > 0,
                        label: Text('${session.cartCount}'),
                        child: const Icon(Icons.shopping_cart_outlined),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            if (categories.isNotEmpty) ...[
              const SizedBox(height: 20),
              Text(
                s.t('categories'),
                style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final category in categories)
                    ActionChip(
                      label: Text('${category.name} (${category.productCount})'),
                      backgroundColor: WingerColors.brandMuted,
                      onPressed: () => context.go(
                        '/customer/search?category=${Uri.encodeComponent(category.name)}',
                      ),
                    ),
                ],
              ),
            ],
            if (deals.isNotEmpty) ...[
              const SizedBox(height: 24),
              Text(
                s.t('currentOffers'),
                style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 10),
              _productStrip(products: deals.take(8).toList(), wide: wide, session: session),
            ],
            const SizedBox(height: 24),
            Row(
              children: [
                Text(
                  s.t('featuredProducts'),
                  style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
                ),
                const Spacer(),
                TextButton(
                  onPressed: () => context.go('/customer/compare'),
                  child: Text('${s.t('compare')} (${session.compareIds.length})'),
                ),
              ],
            ),
            const SizedBox(height: 10),
            _productStrip(products: featured.take(8).toList(), wide: wide, session: session),
            const SizedBox(height: 24),
            Text(
              s.t('products'),
              style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 12),
            GridView.builder(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              itemCount: products.length,
              gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: wide ? 4 : 2,
                mainAxisSpacing: 12,
                crossAxisSpacing: 12,
                childAspectRatio: wide ? 0.68 : 0.64,
              ),
              itemBuilder: (context, index) {
                final product = products[index];
                return ProductCard(
                  product: product,
                  wishlisted: session.isWishlisted(product.id),
                  compareSelected: session.compareIds.contains(product.id),
                  onWishlist: () => unawaited(session.toggleWishlist(product.id)),
                  onCompare: () => session.toggleCompare(product.id),
                  onAddToCart: () => unawaited(session.addToCart(product)),
                  onTap: () => context.go('/customer/product/${product.id}'),
                );
              },
            ),
            if (recent.isNotEmpty) ...[
              const SizedBox(height: 24),
              Text(
                s.t('recentlyViewed'),
                style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 10),
              _productStrip(products: recent, wide: wide, session: session),
            ],
            if (wishlisted.isNotEmpty) ...[
              const SizedBox(height: 24),
              Text(
                s.t('wishlist'),
                style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 10),
              _productStrip(products: wishlisted, wide: wide, session: session),
            ],
          ],
        );
      },
    );
  }
}

class _HomeProductCarousel extends StatefulWidget {
  const _HomeProductCarousel({
    required this.products,
    required this.wide,
    required this.session,
  });

  final List<Product> products;
  final bool wide;
  final AppSession session;

  @override
  State<_HomeProductCarousel> createState() => _HomeProductCarouselState();
}

class _HomeProductCarouselState extends State<_HomeProductCarousel> {
  final _scroll = ScrollController();
  bool _canLeft = false;
  bool _canRight = false;
  bool _overflows = false;

  double get _cardWidth => widget.wide ? 210 : 180;
  double get _step => (_cardWidth + 12) * (widget.wide ? 2 : 1.5);

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_syncArrows);
    WidgetsBinding.instance.addPostFrameCallback((_) => _syncArrows());
  }

  @override
  void didUpdateWidget(covariant _HomeProductCarousel oldWidget) {
    super.didUpdateWidget(oldWidget);
    WidgetsBinding.instance.addPostFrameCallback((_) => _syncArrows());
  }

  @override
  void dispose() {
    _scroll.removeListener(_syncArrows);
    _scroll.dispose();
    super.dispose();
  }

  void _syncArrows() {
    if (!_scroll.hasClients) return;
    final pos = _scroll.position;
    final overflows = pos.maxScrollExtent > 4;
    final left = overflows && pos.pixels > 4;
    final right = overflows && pos.pixels < pos.maxScrollExtent - 4;
    if (left != _canLeft || right != _canRight || overflows != _overflows) {
      setState(() {
        _canLeft = left;
        _canRight = right;
        _overflows = overflows;
      });
    }
  }

  Future<void> _scrollBy(double delta) async {
    if (!_scroll.hasClients) return;
    final target = (_scroll.offset + delta).clamp(0.0, _scroll.position.maxScrollExtent);
    await _scroll.animateTo(
      target,
      duration: const Duration(milliseconds: 280),
      curve: Curves.easeOutCubic,
    );
    _syncArrows();
  }

  Widget _arrowButton({
    required IconData icon,
    required bool enabled,
    required VoidCallback onPressed,
  }) {
    return Material(
      color: enabled ? WingerColors.brand : Colors.white.withValues(alpha: 0.9),
      shape: const CircleBorder(),
      elevation: enabled ? 2 : 1,
      child: IconButton(
        onPressed: enabled ? onPressed : null,
        icon: Icon(icon, color: enabled ? Colors.white : WingerColors.muted),
        tooltip: icon == Icons.chevron_left ? 'Scroll left' : 'Scroll right',
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final height = widget.wide ? 320.0 : 300.0;
    final session = widget.session;
    return SizedBox(
      height: height,
      child: Stack(
        alignment: Alignment.center,
        children: [
          ListView.separated(
            controller: _scroll,
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 40),
            itemCount: widget.products.length,
            separatorBuilder: (_, __) => const SizedBox(width: 12),
            itemBuilder: (context, index) {
              final product = widget.products[index];
              return SizedBox(
                width: _cardWidth,
                child: ProductCard(
                  product: product,
                  wishlisted: session.isWishlisted(product.id),
                  compareSelected: session.compareIds.contains(product.id),
                  onWishlist: () => unawaited(session.toggleWishlist(product.id)),
                  onCompare: () => session.toggleCompare(product.id),
                  onAddToCart: () => unawaited(session.addToCart(product)),
                  onTap: () => context.go('/customer/product/${product.id}'),
                ),
              );
            },
          ),
          if (_overflows) ...[
            Positioned(
              left: 0,
              child: _arrowButton(
                icon: Icons.chevron_left,
                enabled: _canLeft,
                onPressed: () => unawaited(_scrollBy(-_step)),
              ),
            ),
            Positioned(
              right: 0,
              child: _arrowButton(
                icon: Icons.chevron_right,
                enabled: _canRight,
                onPressed: () => unawaited(_scrollBy(_step)),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class CustomerSearchScreen extends StatefulWidget {
  const CustomerSearchScreen({
    super.key,
    this.initialCategory,
    this.initialQuery,
    this.initialSupplierId,
    this.initialSupplierName,
  });

  final String? initialCategory;
  final String? initialQuery;
  final String? initialSupplierId;
  final String? initialSupplierName;

  @override
  State<CustomerSearchScreen> createState() => _CustomerSearchScreenState();
}

class _CustomerSearchScreenState extends State<CustomerSearchScreen> {
  late final TextEditingController _queryCtrl;
  String? _category;
  String? _brand;
  String? _supplierId;
  String? _supplierName;
  String? _color;
  String? _size;
  double? _minRating;
  /// null = any; otherwise [min, max] with null max meaning open-ended.
  (double?, double?)? _priceRange;
  String _sort = 'relevance';
  bool _inStockOnly = false;
  int _page = 1;
  Future<ProductPage>? _future;
  Future<List<CatalogCategory>>? _categoriesFuture;
  Future<List<CatalogCategory>>? _brandsFuture;
  Future<List<CatalogCategory>>? _colorsFuture;
  Future<List<CatalogCategory>>? _sizesFuture;
  Future<List<CatalogSupplier>>? _suppliersFuture;

  @override
  void initState() {
    super.initState();
    _queryCtrl = TextEditingController(text: widget.initialQuery ?? '');
    _category = widget.initialCategory;
    _supplierId = widget.initialSupplierId;
    _supplierName = widget.initialSupplierName;
    final catalog = context.read<CatalogRepository>();
    _categoriesFuture = catalog.getCategories();
    _brandsFuture = catalog.getBrands();
    _colorsFuture = catalog.getColors();
    _sizesFuture = catalog.getSizes();
    _suppliersFuture = catalog.getSuppliers();
    _reload();
  }

  @override
  void dispose() {
    _queryCtrl.dispose();
    super.dispose();
  }

  void _clearFilters() {
    _queryCtrl.clear();
    _category = null;
    _brand = null;
    _supplierId = null;
    _supplierName = null;
    _color = null;
    _size = null;
    _minRating = null;
    _priceRange = null;
    _inStockOnly = false;
    _sort = 'relevance';
    _page = 1;
    _reload();
  }

  String? _priceLabel(WingerStrings s) {
    if (_priceRange == null) return null;
    if (_priceRange!.$1 == null && _priceRange!.$2 == 100) return s.t('priceUnder100');
    if (_priceRange!.$1 == 100 && _priceRange!.$2 == 250) return s.t('price100to250');
    if (_priceRange!.$1 == 250 && _priceRange!.$2 == 500) return s.t('price250to500');
    if (_priceRange!.$1 == 500 && _priceRange!.$2 == null) return s.t('priceOver500');
    return s.t('price');
  }

  List<({String label, VoidCallback onClear})> _activeFilters(WingerStrings s) {
    final chips = <({String label, VoidCallback onClear})>[];
    final q = _queryCtrl.text.trim();
    if (q.isNotEmpty) {
      chips.add((
        label: '"$q"',
        onClear: () {
          _queryCtrl.clear();
          _page = 1;
          _reload();
        },
      ));
    }
    if (_category != null) {
      chips.add((
        label: _category!,
        onClear: () {
          _category = null;
          _page = 1;
          _reload();
        },
      ));
    }
    if (_brand != null) {
      chips.add((
        label: _brand!,
        onClear: () {
          _brand = null;
          _page = 1;
          _reload();
        },
      ));
    }
    if (_supplierId != null) {
      chips.add((
        label: _supplierName ?? _supplierId!,
        onClear: () {
          _supplierId = null;
          _supplierName = null;
          _page = 1;
          _reload();
        },
      ));
    }
    if (_color != null) {
      chips.add((
        label: _color!,
        onClear: () {
          _color = null;
          _page = 1;
          _reload();
        },
      ));
    }
    if (_size != null) {
      chips.add((
        label: _size!,
        onClear: () {
          _size = null;
          _page = 1;
          _reload();
        },
      ));
    }
    final price = _priceLabel(s);
    if (price != null) {
      chips.add((
        label: price,
        onClear: () {
          _priceRange = null;
          _page = 1;
          _reload();
        },
      ));
    }
    if (_minRating != null) {
      chips.add((
        label: _minRating == 4.5 ? s.t('rating45plus') : s.t('rating4plus'),
        onClear: () {
          _minRating = null;
          _page = 1;
          _reload();
        },
      ));
    }
    if (_inStockOnly) {
      chips.add((
        label: s.t('inStockOnly'),
        onClear: () {
          _inStockOnly = false;
          _page = 1;
          _reload();
        },
      ));
    }
    return chips;
  }

  void _reload() {
    setState(() {
      _future = context.read<CatalogRepository>().browseProducts(
            query: _queryCtrl.text,
            category: _category,
            brand: _brand,
            supplierId: _supplierId,
            color: _color,
            size: _size,
            minPrice: _priceRange?.$1,
            maxPrice: _priceRange?.$2,
            minRating: _minRating,
            inStock: _inStockOnly,
            sort: _sort,
            page: _page,
            pageSize: 24,
          );
    });
  }

  void _applyFilter(VoidCallback update) {
    update();
    _page = 1;
    _reload();
  }

  List<({String key, String label, (double?, double?)? range})> _priceOptions(WingerStrings s) => [
        (key: 'any', label: s.t('anyPrice'), range: null),
        (key: 'u100', label: s.t('priceUnder100'), range: (null, 100.0)),
        (key: '100250', label: s.t('price100to250'), range: (100.0, 250.0)),
        (key: '250500', label: s.t('price250to500'), range: (250.0, 500.0)),
        (key: 'o500', label: s.t('priceOver500'), range: (500.0, null)),
      ];

  bool _priceSelected((double?, double?)? range) {
    if (range == null) return _priceRange == null;
    return _priceRange?.$1 == range.$1 && _priceRange?.$2 == range.$2;
  }

  Widget _dropdownPill({
    required String label,
    required bool active,
    required List<PopupMenuEntry<String>> items,
    required ValueChanged<String> onSelected,
  }) {
    return PopupMenuButton<String>(
      onSelected: onSelected,
      itemBuilder: (_) => items,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 140),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: active ? WingerColors.brand : WingerColors.brandMuted,
          borderRadius: BorderRadius.circular(24),
          border: Border.all(
            color: active ? WingerColors.brand : WingerColors.border,
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              label,
              style: TextStyle(
                color: active ? Colors.white : WingerColors.ink,
                fontWeight: FontWeight.w700,
              ),
            ),
            Icon(
              Icons.arrow_drop_down,
              color: active ? Colors.white : WingerColors.ink,
            ),
          ],
        ),
      ),
    );
  }

  Widget _sidebarOption({
    required String label,
    required bool selected,
    required VoidCallback onTap,
  }) {
    return ListTile(
      dense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 8),
      selected: selected,
      selectedTileColor: WingerColors.brand.withValues(alpha: 0.12),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      leading: Icon(
        selected ? Icons.check_circle : Icons.circle_outlined,
        size: 18,
        color: selected ? WingerColors.brand : WingerColors.muted,
      ),
      title: Text(
        label,
        style: TextStyle(
          fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
          color: selected ? WingerColors.brand : WingerColors.ink,
        ),
      ),
      onTap: onTap,
    );
  }

  Widget _buildActiveFiltersBar(WingerStrings s) {
    final active = _activeFilters(s);
    if (active.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(s.t('activeFilters'), style: const TextStyle(fontWeight: FontWeight.w700)),
              const Spacer(),
              TextButton(
                onPressed: _clearFilters,
                style: TextButton.styleFrom(
                  foregroundColor: WingerColors.brand,
                  padding: EdgeInsets.zero,
                  minimumSize: Size.zero,
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
                child: Text(s.t('clearFilters')),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final chip in active)
                InputChip(
                  label: Text(chip.label),
                  onDeleted: chip.onClear,
                  deleteIcon: const Icon(Icons.close, size: 16),
                  selected: true,
                  selectedColor: WingerColors.brandMuted,
                  checkmarkColor: WingerColors.brand,
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildFilterSidebar(WingerStrings s) {
    return ListView(
      padding: const EdgeInsets.only(right: 8),
      children: [
        Text(s.t('categories'), style: const TextStyle(fontWeight: FontWeight.w800)),
        const SizedBox(height: 8),
        FutureBuilder<List<CatalogCategory>>(
          future: _categoriesFuture,
          builder: (context, snapshot) {
            final categories = snapshot.data ?? const <CatalogCategory>[];
            return Column(
              children: [
                _sidebarOption(
                  label: s.t('allCategories'),
                  selected: _category == null,
                  onTap: () => _applyFilter(() => _category = null),
                ),
                for (final category in categories)
                  _sidebarOption(
                    label: category.name,
                    selected: _category == category.name,
                    onTap: () => _applyFilter(() => _category = category.name),
                  ),
              ],
            );
          },
        ),
        ExpansionTile(
          initiallyExpanded: _brand != null,
          title: Text(s.t('brands'), style: const TextStyle(fontWeight: FontWeight.w800)),
          children: [
            FutureBuilder<List<CatalogCategory>>(
              future: _brandsFuture,
              builder: (context, snapshot) {
                final brands = snapshot.data ?? const <CatalogCategory>[];
                return Column(
                  children: [
                    _sidebarOption(
                      label: s.t('allBrands'),
                      selected: _brand == null,
                      onTap: () => _applyFilter(() => _brand = null),
                    ),
                    for (final brand in brands)
                      _sidebarOption(
                        label: brand.name,
                        selected: _brand == brand.name,
                        onTap: () => _applyFilter(() => _brand = brand.name),
                      ),
                  ],
                );
              },
            ),
          ],
        ),
        ExpansionTile(
          initiallyExpanded: _color != null,
          title: Text(s.t('color'), style: const TextStyle(fontWeight: FontWeight.w800)),
          children: [
            FutureBuilder<List<CatalogCategory>>(
              future: _colorsFuture,
              builder: (context, snapshot) {
                final colors = snapshot.data ?? const <CatalogCategory>[];
                return Column(
                  children: [
                    _sidebarOption(
                      label: s.t('allColors'),
                      selected: _color == null,
                      onTap: () => _applyFilter(() => _color = null),
                    ),
                    for (final color in colors)
                      _sidebarOption(
                        label: color.name,
                        selected: _color == color.name,
                        onTap: () => _applyFilter(() => _color = color.name),
                      ),
                  ],
                );
              },
            ),
          ],
        ),
        ExpansionTile(
          initiallyExpanded: _size != null,
          title: Text(s.t('size'), style: const TextStyle(fontWeight: FontWeight.w800)),
          children: [
            FutureBuilder<List<CatalogCategory>>(
              future: _sizesFuture,
              builder: (context, snapshot) {
                final sizes = snapshot.data ?? const <CatalogCategory>[];
                return Column(
                  children: [
                    _sidebarOption(
                      label: s.t('allSizes'),
                      selected: _size == null,
                      onTap: () => _applyFilter(() => _size = null),
                    ),
                    for (final size in sizes)
                      _sidebarOption(
                        label: size.name,
                        selected: _size == size.name,
                        onTap: () => _applyFilter(() => _size = size.name),
                      ),
                  ],
                );
              },
            ),
          ],
        ),
        ExpansionTile(
          initiallyExpanded: _priceRange != null,
          title: Text(s.t('price'), style: const TextStyle(fontWeight: FontWeight.w800)),
          children: [
            for (final option in _priceOptions(s))
              _sidebarOption(
                label: option.label,
                selected: _priceSelected(option.range),
                onTap: () => _applyFilter(() => _priceRange = option.range),
              ),
          ],
        ),
        ExpansionTile(
          initiallyExpanded: _supplierId != null,
          title: Text(s.t('suppliers'), style: const TextStyle(fontWeight: FontWeight.w800)),
          children: [
            FutureBuilder<List<CatalogSupplier>>(
              future: _suppliersFuture,
              builder: (context, snapshot) {
                final suppliers = snapshot.data ?? const <CatalogSupplier>[];
                return Column(
                  children: [
                    _sidebarOption(
                      label: s.t('allSuppliers'),
                      selected: _supplierId == null,
                      onTap: () => _applyFilter(() {
                        _supplierId = null;
                        _supplierName = null;
                      }),
                    ),
                    for (final supplier in suppliers)
                      _sidebarOption(
                        label: supplier.name,
                        selected: _supplierId == supplier.id,
                        onTap: () => _applyFilter(() {
                          _supplierId = supplier.id;
                          _supplierName = supplier.name;
                        }),
                      ),
                  ],
                );
              },
            ),
          ],
        ),
        ExpansionTile(
          initiallyExpanded: _minRating != null,
          title: Text(s.t('rating'), style: const TextStyle(fontWeight: FontWeight.w800)),
          children: [
            _sidebarOption(
              label: s.t('anyRating'),
              selected: _minRating == null,
              onTap: () => _applyFilter(() => _minRating = null),
            ),
            _sidebarOption(
              label: s.t('rating4plus'),
              selected: _minRating == 4.0,
              onTap: () => _applyFilter(() => _minRating = 4.0),
            ),
            _sidebarOption(
              label: s.t('rating45plus'),
              selected: _minRating == 4.5,
              onTap: () => _applyFilter(() => _minRating = 4.5),
            ),
          ],
        ),
        const SizedBox(height: 8),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(s.t('inStockOnly')),
          value: _inStockOnly,
          activeThumbColor: WingerColors.brand,
          onChanged: (value) => _applyFilter(() => _inStockOnly = value),
        ),
      ],
    );
  }

  Widget _buildHorizontalFilterBar(WingerStrings s) {
    return FutureBuilder(
      future: Future.wait([
        _categoriesFuture ?? Future.value(const <CatalogCategory>[]),
        _brandsFuture ?? Future.value(const <CatalogCategory>[]),
        _colorsFuture ?? Future.value(const <CatalogCategory>[]),
        _sizesFuture ?? Future.value(const <CatalogCategory>[]),
        _suppliersFuture ?? Future.value(const <CatalogSupplier>[]),
      ]),
      builder: (context, snapshot) {
        final data = snapshot.data ?? const [];
        final categories = data.isNotEmpty ? data[0] as List<CatalogCategory> : const <CatalogCategory>[];
        final brands = data.length > 1 ? data[1] as List<CatalogCategory> : const <CatalogCategory>[];
        final colors = data.length > 2 ? data[2] as List<CatalogCategory> : const <CatalogCategory>[];
        final sizes = data.length > 3 ? data[3] as List<CatalogCategory> : const <CatalogCategory>[];
        final suppliers = data.length > 4 ? data[4] as List<CatalogSupplier> : const <CatalogSupplier>[];

        return Wrap(
          spacing: 8,
          runSpacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            _dropdownPill(
              label: _category ?? s.t('categories'),
              active: _category != null,
              onSelected: (value) => _applyFilter(() {
                _category = value == '__all__' ? null : value;
              }),
              items: [
                PopupMenuItem(value: '__all__', child: Text(s.t('allCategories'))),
                for (final category in categories)
                  PopupMenuItem(value: category.name, child: Text(category.name)),
              ],
            ),
            _dropdownPill(
              label: _brand ?? s.t('brands'),
              active: _brand != null,
              onSelected: (value) => _applyFilter(() {
                _brand = value == '__all__' ? null : value;
              }),
              items: [
                PopupMenuItem(value: '__all__', child: Text(s.t('allBrands'))),
                for (final brand in brands)
                  PopupMenuItem(value: brand.name, child: Text(brand.name)),
              ],
            ),
            _dropdownPill(
              label: _color ?? s.t('color'),
              active: _color != null,
              onSelected: (value) => _applyFilter(() {
                _color = value == '__all__' ? null : value;
              }),
              items: [
                PopupMenuItem(value: '__all__', child: Text(s.t('allColors'))),
                for (final color in colors)
                  PopupMenuItem(value: color.name, child: Text(color.name)),
              ],
            ),
            _dropdownPill(
              label: _size ?? s.t('size'),
              active: _size != null,
              onSelected: (value) => _applyFilter(() {
                _size = value == '__all__' ? null : value;
              }),
              items: [
                PopupMenuItem(value: '__all__', child: Text(s.t('allSizes'))),
                for (final size in sizes)
                  PopupMenuItem(value: size.name, child: Text(size.name)),
              ],
            ),
            _dropdownPill(
              label: _priceLabel(s) ?? s.t('price'),
              active: _priceRange != null,
              onSelected: (value) {
                final match = _priceOptions(s).where((o) => o.key == value);
                if (match.isEmpty) return;
                _applyFilter(() => _priceRange = match.first.range);
              },
              items: [
                for (final option in _priceOptions(s))
                  PopupMenuItem(value: option.key, child: Text(option.label)),
              ],
            ),
            _dropdownPill(
              label: _supplierName ?? s.t('suppliers'),
              active: _supplierId != null,
              onSelected: (value) {
                if (value == '__all__') {
                  _applyFilter(() {
                    _supplierId = null;
                    _supplierName = null;
                  });
                  return;
                }
                final match = suppliers.where((supplier) => supplier.id == value);
                if (match.isEmpty) return;
                _applyFilter(() {
                  _supplierId = match.first.id;
                  _supplierName = match.first.name;
                });
              },
              items: [
                PopupMenuItem(value: '__all__', child: Text(s.t('allSuppliers'))),
                for (final supplier in suppliers)
                  PopupMenuItem(value: supplier.id, child: Text(supplier.name)),
              ],
            ),
            _dropdownPill(
              label: _minRating == null
                  ? s.t('rating')
                  : (_minRating == 4.5 ? s.t('rating45plus') : s.t('rating4plus')),
              active: _minRating != null,
              onSelected: (value) => _applyFilter(() {
                _minRating = value == '__all__'
                    ? null
                    : value == '4.5'
                        ? 4.5
                        : 4.0;
              }),
              items: [
                PopupMenuItem(value: '__all__', child: Text(s.t('anyRating'))),
                PopupMenuItem(value: '4', child: Text(s.t('rating4plus'))),
                PopupMenuItem(value: '4.5', child: Text(s.t('rating45plus'))),
              ],
            ),
            FilterChip(
              label: Text(s.t('inStockOnly')),
              selected: _inStockOnly,
              selectedColor: WingerColors.brand,
              checkmarkColor: Colors.white,
              labelStyle: TextStyle(
                color: _inStockOnly ? Colors.white : WingerColors.ink,
                fontWeight: FontWeight.w700,
              ),
              onSelected: (value) => _applyFilter(() => _inStockOnly = value),
            ),
          ],
        );
      },
    );
  }

  Widget _buildSortRow(WingerStrings s) {
    return Row(
      children: [
        DropdownButton<String>(
          value: _sort,
          underline: const SizedBox.shrink(),
          items: [
            DropdownMenuItem(value: 'relevance', child: Text(s.t('sortRelevance'))),
            DropdownMenuItem(value: 'price_asc', child: Text(s.t('sortPriceAsc'))),
            DropdownMenuItem(value: 'price_desc', child: Text(s.t('sortPriceDesc'))),
            DropdownMenuItem(value: 'rating', child: Text(s.t('sortRating'))),
            DropdownMenuItem(value: 'newest', child: Text(s.t('sortNewest'))),
          ],
          onChanged: (value) {
            if (value == null) return;
            _applyFilter(() => _sort = value);
          },
        ),
      ],
    );
  }

  Widget _buildResults(WingerStrings s, AppSession session, {required bool wideGrid}) {
    final future = _future;
    if (future == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return FutureBuilder<ProductPage>(
      future: future,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Padding(
            padding: EdgeInsets.all(24),
            child: Center(child: CircularProgressIndicator()),
          );
        }
        final page = snapshot.data;
        final items = page?.items ?? const <Product>[];
        if (items.isEmpty) {
          return Padding(
            padding: const EdgeInsets.symmetric(vertical: 32),
            child: Column(
              children: [
                const Icon(Icons.search_off, size: 48, color: WingerColors.muted),
                const SizedBox(height: 12),
                Text(s.t('noResults'), style: TextStyle(color: WingerColors.muted)),
                const SizedBox(height: 8),
                TextButton(
                  onPressed: _clearFilters,
                  child: Text(s.t('clearFilters')),
                ),
              ],
            ),
          );
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '${page!.total} ${s.t('products').toLowerCase()}',
              style: TextStyle(color: WingerColors.muted, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 12),
            GridView.builder(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              itemCount: items.length,
              gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: wideGrid ? 3 : 2,
                mainAxisSpacing: 12,
                crossAxisSpacing: 12,
                childAspectRatio: wideGrid ? 0.68 : 0.64,
              ),
              itemBuilder: (context, index) {
                final product = items[index];
                return ProductCard(
                  product: product,
                  wishlisted: session.isWishlisted(product.id),
                  compareSelected: session.compareIds.contains(product.id),
                  onWishlist: () => unawaited(session.toggleWishlist(product.id)),
                  onCompare: () => session.toggleCompare(product.id),
                  onAddToCart: () => unawaited(session.addToCart(product)),
                  onTap: () => context.go('/customer/product/${product.id}'),
                );
              },
            ),
            if (page.totalPages > 1) ...[
              const SizedBox(height: 16),
              Row(
                children: [
                  OutlinedButton(
                    onPressed: _page <= 1
                        ? null
                        : () {
                            _page -= 1;
                            _reload();
                          },
                    child: Text(s.t('back')),
                  ),
                  const SizedBox(width: 12),
                  Text('${s.t('page')} $_page / ${page.totalPages}'),
                  const SizedBox(width: 12),
                  OutlinedButton(
                    onPressed: _page >= page.totalPages
                        ? null
                        : () {
                            _page += 1;
                            _reload();
                          },
                    child: Text(s.t('continueRole')),
                  ),
                ],
              ),
            ],
          ],
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final session = context.watch<AppSession>();
    final width = MediaQuery.sizeOf(context).width;
    final useSidebar = width >= 1100;

    final header = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                s.t('search'),
                style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
            IconButton(
              tooltip: s.t('cart'),
              onPressed: () => context.go('/customer/cart'),
              icon: Badge(
                isLabelVisible: session.cartCount > 0,
                label: Text('${session.cartCount}'),
                child: const Icon(Icons.shopping_cart_outlined),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _queryCtrl,
          autofocus: widget.initialQuery == null && widget.initialCategory == null,
          decoration: InputDecoration(
            hintText: s.t('searchHint'),
            prefixIcon: const Icon(Icons.search),
            suffixIcon: IconButton(
              onPressed: () {
                _page = 1;
                _reload();
              },
              icon: const Icon(Icons.arrow_forward),
            ),
          ),
          onSubmitted: (_) {
            _page = 1;
            _reload();
          },
        ),
        _buildActiveFiltersBar(s),
      ],
    );

    if (useSidebar) {
      return Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            header,
            const SizedBox(height: 16),
            Expanded(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 280,
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        color: WingerColors.white,
                        border: Border.all(color: WingerColors.border),
                        borderRadius: BorderRadius.circular(16),
                      ),
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(12, 12, 8, 12),
                        child: _buildFilterSidebar(s),
                      ),
                    ),
                  ),
                  const SizedBox(width: 20),
                  Expanded(
                    child: ListView(
                      children: [
                        _buildSortRow(s),
                        const SizedBox(height: 12),
                        _buildResults(s, session, wideGrid: true),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      );
    }

    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        header,
        const SizedBox(height: 12),
        _buildHorizontalFilterBar(s),
        const SizedBox(height: 8),
        _buildSortRow(s),
        const SizedBox(height: 12),
        _buildResults(s, session, wideGrid: width >= 900),
      ],
    );
  }
}

class WishlistScreen extends StatelessWidget {
  const WishlistScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final session = context.watch<AppSession>();
    final catalog = context.read<CatalogRepository>();
    final wide = MediaQuery.sizeOf(context).width >= 900;

    return FutureBuilder<List<Product>>(
      future: catalog.getProducts(),
      builder: (context, snapshot) {
        final all = snapshot.data ?? const <Product>[];
        final map = {for (final p in all) p.id: p};
        final items = [
          for (final id in session.wishlistIds)
            if (map[id] != null) map[id]!,
        ];
        return ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Text(s.t('wishlist'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: 12),
            if (items.isEmpty)
              Text(s.t('wishlistEmpty'), style: TextStyle(color: WingerColors.muted))
            else
              GridView.builder(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                itemCount: items.length,
                gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: wide ? 4 : 2,
                  mainAxisSpacing: 12,
                  crossAxisSpacing: 12,
                  childAspectRatio: wide ? 0.68 : 0.64,
                ),
                itemBuilder: (context, index) {
                  final product = items[index];
                  return ProductCard(
                    product: product,
                    wishlisted: true,
                    onWishlist: () => unawaited(session.toggleWishlist(product.id)),
                    onAddToCart: () => unawaited(session.addToCart(product)),
                    onTap: () => context.go('/customer/product/${product.id}'),
                  );
                },
              ),
          ],
        );
      },
    );
  }
}

class ProductDetailScreen extends StatefulWidget {
  const ProductDetailScreen({super.key, required this.productId});

  final String productId;

  @override
  State<ProductDetailScreen> createState() => _ProductDetailScreenState();
}

enum _DeliveryOption { express, standard, pickup }

class _ProductDetailScreenState extends State<ProductDetailScreen> {
  int qty = 1;
  late Future<Product> _future;
  Future<List<Product>>? _relatedFuture;
  Future<SupplierProfile>? _supplierFuture;
  _DeliveryOption? _delivery;
  int _galleryIndex = 0;
  late final PageController _galleryPageCtrl;

  static const _deliveryLabels = <_DeliveryOption, String>{
    _DeliveryOption.express: 'Express 1–2 days',
    _DeliveryOption.standard: 'Standard 3–5 days',
    _DeliveryOption.pickup: 'Pickup',
  };

  @override
  void initState() {
    super.initState();
    _galleryPageCtrl = PageController();
    _future = context.read<CatalogRepository>().getProduct(widget.productId);
    unawaited(_recordView());
    _future.then((product) {
      if (!mounted) return;
      final catalog = context.read<CatalogRepository>();
      setState(() {
        _supplierFuture = catalog.getSupplierProfile(product.supplierId);
        _relatedFuture = () async {
          final byModel = await catalog.getProducts(query: product.model);
          final byCategory = await catalog.browseProducts(
            category: product.category,
            pageSize: 8,
            sort: 'rating',
          );
          final seen = <String>{product.id};
          final related = <Product>[];
          // Prefer same model from other suppliers first (price compare).
          for (final item in byModel) {
            if (item.id == product.id) continue;
            if (item.model.toLowerCase() != product.model.toLowerCase()) continue;
            if (seen.add(item.id)) related.add(item);
          }
          for (final item in byCategory.items) {
            if (seen.add(item.id)) related.add(item);
            if (related.length >= 6) break;
          }
          return related.take(6).toList();
        }();
      });
    });
  }

  Future<void> _recordView() async {
    await context.read<AppSession>().markProductViewed(widget.productId);
  }

  @override
  void dispose() {
    _galleryPageCtrl.dispose();
    super.dispose();
  }

  String _estimateFor(_DeliveryOption option, String city) {
    switch (option) {
      case _DeliveryOption.express:
        return '1–2 days to $city';
      case _DeliveryOption.pickup:
        return 'Ready for pickup in $city';
      case _DeliveryOption.standard:
        return '3–5 days to $city';
    }
  }

  List<String> _galleryUrls(Product product) {
    final urls = product.galleryUrls;
    // Prefer real product photos only — never pad with unrelated catalogue images.
    if (urls.isEmpty) return const [''];
    return urls;
  }

  void _goGallery(int index, int total) {
    final next = index.clamp(0, total - 1);
    setState(() => _galleryIndex = next);
    if (_galleryPageCtrl.hasClients) {
      _galleryPageCtrl.animateToPage(
        next,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
      );
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _delivery ??= _deliveryFromSession(context.read<AppSession>().deliveryMethod);
  }

  _DeliveryOption _deliveryFromSession(String method) {
    switch (method) {
      case 'express':
        return _DeliveryOption.express;
      case 'pickup':
        return _DeliveryOption.pickup;
      default:
        return _DeliveryOption.standard;
    }
  }

  String _deliveryToSession(_DeliveryOption option) {
    switch (option) {
      case _DeliveryOption.express:
        return 'express';
      case _DeliveryOption.pickup:
        return 'pickup';
      case _DeliveryOption.standard:
        return 'standard';
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final session = context.watch<AppSession>();
    final selected = _delivery ?? _DeliveryOption.standard;

    return FutureBuilder(
      future: _future,
      builder: (context, snapshot) {
        final product = snapshot.data ?? MockCatalog.byId(widget.productId);
        return FutureBuilder<List<Product>>(
          future: _relatedFuture,
          builder: (context, relatedSnap) {
            final related = relatedSnap.data ?? const <Product>[];
            final gallery = _galleryUrls(product);
            final safeIndex = _galleryIndex.clamp(0, gallery.length - 1);
            return ListView(
              padding: const EdgeInsets.all(20),
              children: [
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton.icon(
                    onPressed: () => context.go('/customer'),
                    icon: const Icon(Icons.arrow_back),
                    label: Text(s.t('home')),
                  ),
                ),
                Builder(
                  builder: (context) {
                    final screen = MediaQuery.sizeOf(context);
                    final galleryHeight = (screen.height * 0.36).clamp(220.0, 340.0);
                    return Align(
                      alignment: Alignment.centerLeft,
                      child: ConstrainedBox(
                        constraints: BoxConstraints(
                          maxWidth: screen.width >= 900 ? 520 : double.infinity,
                          maxHeight: galleryHeight,
                        ),
                        child: SizedBox(
                          width: double.infinity,
                          height: galleryHeight,
                          child: ClipRRect(
                            borderRadius: BorderRadius.circular(16),
                            child: Stack(
                              fit: StackFit.expand,
                              children: [
                                PageView.builder(
                                  controller: _galleryPageCtrl,
                                  itemCount: gallery.length,
                                  onPageChanged: (index) => setState(() => _galleryIndex = index),
                                  itemBuilder: (context, index) {
                                    return ColoredBox(
                                      color: WingerColors.brandMuted,
                                      child: ProductPhoto(
                                        url: gallery[index],
                                        fit: BoxFit.contain,
                                        iconSize: 40,
                                      ),
                                    );
                                  },
                                ),
                                if (gallery.length > 1) ...[
                                  Align(
                                    alignment: Alignment.centerLeft,
                                    child: IconButton(
                                      style: IconButton.styleFrom(
                                        backgroundColor: Colors.black45,
                                        foregroundColor: Colors.white,
                                      ),
                                      onPressed: safeIndex > 0
                                          ? () => _goGallery(safeIndex - 1, gallery.length)
                                          : null,
                                      icon: const Icon(Icons.chevron_left),
                                    ),
                                  ),
                                  Align(
                                    alignment: Alignment.centerRight,
                                    child: IconButton(
                                      style: IconButton.styleFrom(
                                        backgroundColor: Colors.black45,
                                        foregroundColor: Colors.white,
                                      ),
                                      onPressed: safeIndex < gallery.length - 1
                                          ? () => _goGallery(safeIndex + 1, gallery.length)
                                          : null,
                                      icon: const Icon(Icons.chevron_right),
                                    ),
                                  ),
                                ],
                                Positioned(
                                  right: 12,
                                  bottom: 12,
                                  child: Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                                    decoration: BoxDecoration(
                                      color: Colors.black54,
                                      borderRadius: BorderRadius.circular(20),
                                    ),
                                    child: Text(
                                      s
                                          .t('imageOf')
                                          .replaceAll('{current}', '${safeIndex + 1}')
                                          .replaceAll('{total}', '${gallery.length}'),
                                      style: const TextStyle(
                                        color: Colors.white,
                                        fontWeight: FontWeight.w700,
                                        fontSize: 12,
                                      ),
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    );
                  },
                ),
                if (gallery.length > 1) ...[
                  const SizedBox(height: 10),
                  SizedBox(
                    height: 72,
                    child: ListView.separated(
                      scrollDirection: Axis.horizontal,
                      itemCount: gallery.length,
                      separatorBuilder: (_, __) => const SizedBox(width: 8),
                      itemBuilder: (context, index) {
                        final selectedThumb = index == safeIndex;
                        return InkWell(
                          onTap: () => _goGallery(index, gallery.length),
                          child: AnimatedContainer(
                            duration: const Duration(milliseconds: 160),
                            decoration: BoxDecoration(
                              borderRadius: BorderRadius.circular(10),
                              border: Border.all(
                                color: selectedThumb ? WingerColors.brand : WingerColors.border,
                                width: selectedThumb ? 2 : 1,
                              ),
                            ),
                            child: ClipRRect(
                              borderRadius: BorderRadius.circular(9),
                              child: SizedBox(
                                width: 72,
                                height: 72,
                                child: ProductPhoto(
                                  url: gallery[index],
                                  iconSize: 20,
                                ),
                              ),
                            ),
                          ),
                        );
                      },
                    ),
                  ),
                ],
                const SizedBox(height: 16),
                Text(product.brand, style: const TextStyle(color: WingerColors.muted, fontWeight: FontWeight.w600)),
                Text(product.name, style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
                const SizedBox(height: 8),
                Text('\$${product.price.toStringAsFixed(2)}',
                    style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w800, color: WingerColors.brand)),
                if (product.previousPrice != null && product.previousPrice! > product.price) ...[
                  const SizedBox(height: 4),
                  Text(
                    '\$${product.previousPrice!.toStringAsFixed(2)}',
                    style: const TextStyle(
                      decoration: TextDecoration.lineThrough,
                      color: WingerColors.muted,
                    ),
                  ),
                ],
                const SizedBox(height: 8),
                Text(
                  '★ ${product.rating.toStringAsFixed(1)} · ${product.category}',
                  style: TextStyle(color: WingerColors.muted, fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 8),
                Text(
                  product.stockStatus == StockStatus.outOfStock
                      ? s.t('outOfStock')
                      : product.stockStatus == StockStatus.lowStock
                          ? '${s.t('lowStock')} · ${product.stock}'
                          : '${s.t('inStock')} · ${product.stock}',
                  style: TextStyle(
                    color: product.stockStatus == StockStatus.outOfStock
                        ? WingerColors.dangerInk
                        : WingerColors.successInk,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 16),
                FutureBuilder<SupplierProfile>(
                  future: _supplierFuture,
                  builder: (context, supplierSnap) {
                    final profile = supplierSnap.data;
                    final name = profile?.name ?? product.supplierName;
                    final verified = profile?.verified ?? product.supplierVerified;
                    final avg = profile?.ratingAvg ?? product.supplierRatingAvg;
                    final count = profile?.ratingCount ?? product.supplierRatingCount;
                    final bio = profile?.businessBio;
                    final notes = profile?.deliveryNotes;
                    final productCount = profile?.productCount;
                    return Card(
                      child: Padding(
                        padding: const EdgeInsets.all(14),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(s.t('soldBy'), style: TextStyle(color: WingerColors.muted, fontWeight: FontWeight.w600)),
                            const SizedBox(height: 4),
                            Row(
                              children: [
                                Expanded(
                                  child: Text(name, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
                                ),
                                if (verified)
                                  const Icon(Icons.verified, size: 18, color: WingerColors.brand),
                              ],
                            ),
                            const SizedBox(height: 4),
                            Text(
                              count > 0
                                  ? '${s.t('supplierRating')}: ★ ${avg.toStringAsFixed(1)} ($count)'
                                  : s.t('noSupplierRatingsYet'),
                              style: TextStyle(color: WingerColors.muted, fontWeight: FontWeight.w600),
                            ),
                            if (productCount != null) ...[
                              const SizedBox(height: 2),
                              Text(
                                '$productCount ${s.t('products').toLowerCase()}',
                                style: TextStyle(color: WingerColors.muted),
                              ),
                            ],
                            if (bio != null && bio.isNotEmpty) ...[
                              const SizedBox(height: 8),
                              Text(bio),
                            ],
                            if (notes != null && notes.isNotEmpty) ...[
                              const SizedBox(height: 6),
                              Text(notes, style: TextStyle(color: WingerColors.muted, fontSize: 13)),
                            ],
                            const SizedBox(height: 10),
                            TextButton(
                              onPressed: () => context.go(
                                '/customer/search?supplierId=${Uri.encodeComponent(product.supplierId)}'
                                '&supplier=${Uri.encodeComponent(name)}',
                              ),
                              child: Text(s.t('viewSupplierProducts')),
                            ),
                          ],
                        ),
                      ),
                    );
                  },
                ),
                const SizedBox(height: 16),
                Text(product.description),
                if (product.visibleSpecs.isNotEmpty) ...[
                  const SizedBox(height: 20),
                  Text(s.t('specifications'), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
                  const SizedBox(height: 8),
                  for (final spec in product.visibleSpecs)
                    _SpecRow(
                      label: switch (spec.label) {
                        'sku' => s.t('sku'),
                        'categories' => s.t('categories'),
                        'color' => s.t('color'),
                        'size' => s.t('size'),
                        'battery' => s.t('battery'),
                        'weight' => s.t('weight'),
                        _ => spec.label,
                      },
                      value: spec.value,
                    ),
                ],
                const SizedBox(height: 20),
                Text(
                  '${s.t('deliveryTo')}: ${session.city}',
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final option in _DeliveryOption.values)
                      ChoiceChip(
                        label: Text(_deliveryLabels[option]!),
                        selected: selected == option,
                        selectedColor: WingerColors.brandMuted,
                        onSelected: (_) {
                          setState(() => _delivery = option);
                          session.setDeliveryMethod(_deliveryToSession(option));
                        },
                      ),
                  ],
                ),
                const SizedBox(height: 8),
                Text(
                  '${s.t('deliveryEstimate')}: ${_estimateFor(selected, session.city)}',
                  style: TextStyle(color: WingerColors.muted),
                ),
                const SizedBox(height: 16),
                Row(
                  children: [
                    Text('${s.t('qty')}:'),
                    const SizedBox(width: 12),
                    IconButton(onPressed: qty > 1 ? () => setState(() => qty--) : null, icon: const Icon(Icons.remove_circle_outline)),
                    Text('$qty', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
                    IconButton(
                      onPressed: qty < product.stock ? () => setState(() => qty++) : null,
                      icon: const Icon(Icons.add_circle_outline),
                    ),
                  ],
                ),
                if (product.stock > 0 && product.stock <= 5)
                  Text(
                    s.t('stockWarning').replaceAll('{n}', '${product.stock}'),
                    style: TextStyle(color: WingerColors.attentionInk, fontWeight: FontWeight.w600),
                  ),
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: product.stock <= 0
                      ? null
                      : () async {
                          session.setDeliveryMethod(_deliveryToSession(selected));
                          await session.addToCart(product, quantity: qty.clamp(1, product.stock));
                          if (!context.mounted) return;
                          await _showAddedToCartChoices(context, productName: product.name);
                        },
                  child: Text(s.t('addToCart')),
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: () => unawaited(session.toggleWishlist(product.id)),
                        icon: Icon(
                          session.isWishlisted(product.id) ? Icons.favorite : Icons.favorite_border,
                        ),
                        label: Text(s.t('wishlist')),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: () {
                          // Replace prior compare picks so unrelated items
                          // (e.g. a watch) are not mixed with this model.
                          final sameModelIds = <String>{
                            product.id,
                            for (final item in related)
                              if (item.model.toLowerCase() ==
                                      product.model.toLowerCase() &&
                                  item.brand.toLowerCase() ==
                                      product.brand.toLowerCase())
                                item.id,
                          }.toList();
                          session.setCompare(sameModelIds);
                          // Navigate directly — tray in CustomerShell shows
                          // status without overlaying Cart / other actions.
                          ScaffoldMessenger.of(context).clearSnackBars();
                          context.go('/customer/compare');
                        },
                        icon: Icon(
                          session.compareIds.contains(product.id)
                              ? Icons.compare_arrows
                              : Icons.compare_arrows_outlined,
                        ),
                        label: Text(s.t('compare')),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                OutlinedButton(
                  onPressed: () => context.go('/customer/cart'),
                  child: Text(s.t('cart')),
                ),
                Builder(
                  builder: (context) {
                    final otherSuppliers = related
                        .where(
                          (item) =>
                              item.model.toLowerCase() == product.model.toLowerCase() &&
                              item.brand.toLowerCase() == product.brand.toLowerCase() &&
                              item.supplierId != product.supplierId,
                        )
                        .toList();
                    final moreRelated = related
                        .where((item) => !otherSuppliers.any((o) => o.id == item.id))
                        .toList();
                    return Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (otherSuppliers.isNotEmpty) ...[
                          const SizedBox(height: 24),
                          Text(
                            s.t('otherSuppliers'),
                            style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
                          ),
                          const SizedBox(height: 10),
                          for (final offer in otherSuppliers)
                            Card(
                              child: ListTile(
                                leading: ClipRRect(
                                  borderRadius: BorderRadius.circular(8),
                                  child: Image.network(
                                    offer.imageUrl,
                                    width: 48,
                                    height: 48,
                                    fit: BoxFit.cover,
                                  ),
                                ),
                                title: Text(
                                  offer.supplierName,
                                  style: const TextStyle(fontWeight: FontWeight.w800),
                                ),
                                subtitle: Text(
                                  '\$${offer.price.toStringAsFixed(2)} · ★ ${offer.rating.toStringAsFixed(1)} · ${offer.stock} in stock',
                                ),
                                trailing: const Icon(Icons.chevron_right),
                                onTap: () => context.go('/customer/product/${offer.id}'),
                              ),
                            ),
                          const SizedBox(height: 8),
                          OutlinedButton.icon(
                            onPressed: () {
                              session.setCompare([
                                product.id,
                                ...otherSuppliers.map((o) => o.id),
                              ]);
                              context.go('/customer/compare');
                            },
                            icon: const Icon(Icons.compare_arrows),
                            label: Text(s.t('compare')),
                          ),
                        ],
                        if (moreRelated.isNotEmpty) ...[
                          const SizedBox(height: 24),
                          Text(
                            s.t('relatedProducts'),
                            style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
                          ),
                          const SizedBox(height: 10),
                          SizedBox(
                            height: 300,
                            child: ListView.separated(
                              scrollDirection: Axis.horizontal,
                              itemCount: moreRelated.length,
                              separatorBuilder: (_, __) => const SizedBox(width: 12),
                              itemBuilder: (context, index) {
                                final item = moreRelated[index];
                                return SizedBox(
                                  width: 180,
                                  child: ProductCard(
                                    product: item,
                                    wishlisted: session.isWishlisted(item.id),
                                    onWishlist: () => unawaited(session.toggleWishlist(item.id)),
                                    onAddToCart: () => unawaited(session.addToCart(item)),
                                    onTap: () => context.go('/customer/product/${item.id}'),
                                  ),
                                );
                              },
                            ),
                          ),
                        ],
                      ],
                    );
                  },
                ),
              ],
            );
          },
        );
      },
    );
  }
}

class _SpecRow extends StatelessWidget {
  const _SpecRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        children: [
          SizedBox(
            width: 110,
            child: Text(label, style: TextStyle(color: WingerColors.muted, fontWeight: FontWeight.w600)),
          ),
          Expanded(child: Text(value, style: const TextStyle(fontWeight: FontWeight.w600))),
        ],
      ),
    );
  }
}

class CompareScreen extends StatefulWidget {
  const CompareScreen({super.key});

  @override
  State<CompareScreen> createState() => _CompareScreenState();
}

class _CompareScreenState extends State<CompareScreen> {
  Future<List<Product>>? _future;
  String _compareKey = '';

  Future<List<Product>> _load() async {
    final session = context.read<AppSession>();
    final catalog = context.read<CatalogRepository>();
    final products = <Product>[];
    for (final id in session.compareIds) {
      products.add(await catalog.getProduct(id));
    }
    return products;
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final session = context.watch<AppSession>();
    final key = session.compareIds.join('|');
    if (_future == null || key != _compareKey) {
      _compareKey = key;
      _future = _load();
    }

    return FutureBuilder<List<Product>>(
      future: _future,
      builder: (context, snapshot) {
        final products = snapshot.data ?? const <Product>[];
        return ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Row(
              children: [
                Text(s.t('compare'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
                const Spacer(),
                if (session.compareIds.isNotEmpty)
                  TextButton(
                    onPressed: session.clearCompare,
                    child: Text(s.t('clearFilters')),
                  ),
              ],
            ),
            const SizedBox(height: 12),
            if (session.compareIds.isEmpty)
              Text(s.t('searchHint'), style: TextStyle(color: WingerColors.muted))
            else if (snapshot.connectionState != ConnectionState.done)
              const Center(child: CircularProgressIndicator())
            else ...[
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final product in products)
                    InputChip(
                      label: Text(
                        '${product.supplierName} · \$${product.price.toStringAsFixed(0)}',
                        overflow: TextOverflow.ellipsis,
                      ),
                      onDeleted: () => session.removeFromCompare(product.id),
                      deleteIcon: const Icon(Icons.close, size: 16),
                    ),
                ],
              ),
              const SizedBox(height: 12),
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: DataTable(
                  headingRowHeight: 56,
                  dataRowMinHeight: 48,
                  dataRowMaxHeight: 56,
                  columns: [
                    const DataColumn(label: Text('Spec')),
                    ...products.map(
                      (p) => DataColumn(
                        label: SizedBox(
                          width: 140,
                          child: Text(
                            '${p.name}\n${p.supplierName}',
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontWeight: FontWeight.w700, height: 1.2),
                          ),
                        ),
                      ),
                    ),
                  ],
                  rows: [
                    DataRow(cells: [
                      const DataCell(Text('Price')),
                      ...products.map((p) => DataCell(Text('\$${p.price.toStringAsFixed(2)}'))),
                    ]),
                    DataRow(cells: [
                      const DataCell(Text('Supplier')),
                      ...products.map((p) => DataCell(Text(p.supplierName))),
                    ]),
                    DataRow(cells: [
                      const DataCell(Text('Verified')),
                      ...products.map((p) => DataCell(Text(p.supplierVerified ? 'Yes' : 'No'))),
                    ]),
                    DataRow(cells: [
                      const DataCell(Text('Rating')),
                      ...products.map((p) => DataCell(Text(p.rating.toStringAsFixed(1)))),
                    ]),
                    DataRow(cells: [
                      const DataCell(Text('Stock')),
                      ...products.map((p) => DataCell(Text('${p.stock} (${p.stockStatus.name})'))),
                    ]),
                    DataRow(cells: [
                      DataCell(Text(s.t('fulfillMethod'))),
                      ...products.map((_) => DataCell(Text(session.deliveryMethodLabel))),
                    ]),
                    DataRow(cells: [
                      const DataCell(Text('Model')),
                      ...products.map((p) => DataCell(Text(p.model))),
                    ]),
                    DataRow(cells: [
                      const DataCell(Text('Color')),
                      ...products.map((p) => DataCell(Text(p.color))),
                    ]),
                    DataRow(cells: [
                      const DataCell(Text('Size')),
                      ...products.map((p) => DataCell(Text(p.size))),
                    ]),
                    DataRow(cells: [
                      const DataCell(Text('Battery')),
                      ...products.map((p) => DataCell(Text(p.battery))),
                    ]),
                    DataRow(cells: [
                      const DataCell(Text('Weight')),
                      ...products.map((p) => DataCell(Text(p.weight))),
                    ]),
                  ],
                ),
              ),
            ],
            const SizedBox(height: 16),
            if (products.isNotEmpty)
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final product in products)
                    FilledButton(
                      onPressed: product.stock <= 0
                          ? null
                          : () async {
                              await session.addToCart(product);
                              if (!context.mounted) return;
                              context.go('/customer/cart');
                            },
                      child: Text('${s.t('addToCart')}: ${product.name}'),
                    ),
                ],
              ),
          ],
        );
      },
    );
  }
}

class CartScreen extends StatefulWidget {
  const CartScreen({super.key});

  @override
  State<CartScreen> createState() => _CartScreenState();
}

class _CartScreenState extends State<CartScreen> {
  bool _refreshing = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _refresh());
  }

  Future<void> _refresh() async {
    final session = context.read<AppSession>();
    if (session.cart.isEmpty) return;
    setState(() => _refreshing = true);
    final ok = await session.refreshCartFromServer();
    if (!mounted) return;
    setState(() => _refreshing = false);
    if (ok) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(WingerStrings.of(context).t('cartUpdated'))),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final session = context.watch<AppSession>();
    final grouped = session.cartBySupplier;
    final hasStockIssue = session.cart.any(
      (item) => item.quantity > item.product.stock || item.product.stock <= 0,
    );

    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Row(
          children: [
            Text(s.t('cart'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
            const Spacer(),
            IconButton(
              onPressed: _refreshing ? null : _refresh,
              icon: _refreshing
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.refresh),
            ),
          ],
        ),
        const SizedBox(height: 8),
        Text(
          '${s.t('fulfillMethod')}: ${session.deliveryMethodLabel}',
          style: TextStyle(color: WingerColors.muted),
        ),
        if (_refreshing) ...[
          const SizedBox(height: 8),
          Text(s.t('refreshingCart'), style: TextStyle(color: WingerColors.muted)),
        ],
        const SizedBox(height: 12),
        if (grouped.isEmpty)
          Text(s.t('explore'))
        else ...[
          if (hasStockIssue) ...[
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: WingerColors.attention,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Text(
                s.t('unavailableItem'),
                style: TextStyle(color: WingerColors.attentionInk, fontWeight: FontWeight.w700),
              ),
            ),
            const SizedBox(height: 12),
          ],
          for (final entry in grouped.entries) ...[
            Text(entry.key, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
            const SizedBox(height: 8),
            for (final item in entry.value)
              Card(
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: ListTile(
                    leading: ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      child: Image.network(
                        item.product.imageUrl,
                        width: 48,
                        height: 48,
                        fit: BoxFit.cover,
                      ),
                    ),
                    title: Text(item.product.name, style: const TextStyle(fontWeight: FontWeight.w700)),
                    subtitle: Text(
                      item.quantity > item.product.stock || item.product.stock <= 0
                          ? '${s.t('unavailableItem')}\n\$${item.product.price.toStringAsFixed(2)} × ${item.quantity}'
                          : '\$${item.product.price.toStringAsFixed(2)} × ${item.quantity} = \$${item.lineTotal.toStringAsFixed(2)}',
                      style: TextStyle(
                        color: item.quantity > item.product.stock || item.product.stock <= 0
                            ? WingerColors.dangerInk
                            : null,
                      ),
                    ),
                    isThreeLine: true,
                    trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        IconButton(
                          onPressed: () => unawaited(
                            session.updateQuantity(item.product.id, item.quantity - 1),
                          ),
                          icon: const Icon(Icons.remove),
                        ),
                        Text('${item.quantity}'),
                        IconButton(
                          onPressed: item.quantity >= item.product.stock
                              ? null
                              : () => unawaited(
                                    session.updateQuantity(
                                      item.product.id,
                                      item.quantity + 1,
                                    ),
                                  ),
                          icon: const Icon(Icons.add),
                        ),
                        IconButton(
                          tooltip: s.t('remove'),
                          onPressed: () => unawaited(session.removeFromCart(item.product.id)),
                          icon: const Icon(Icons.delete_outline),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            const SizedBox(height: 12),
          ],
          Text(
            '${s.t('subtotal')}: \$${session.cartTotal.toStringAsFixed(2)}',
            style: TextStyle(color: WingerColors.muted),
          ),
          Text(
            '${s.t('deliveryFee')}: \$${session.cartDeliveryFee.toStringAsFixed(2)}'
            '${session.cartBySupplier.length > 1 ? ' · ${session.cartBySupplier.length} ${s.t('suppliers').toLowerCase()}' : ''}',
            style: TextStyle(color: WingerColors.muted),
          ),
          Text(
            '${s.t('estimatedTax')}: \$${session.cartTax.toStringAsFixed(2)}',
            style: TextStyle(color: WingerColors.muted),
          ),
          const SizedBox(height: 4),
          Text(
            '${s.t('dueToday')}: \$${session.cartGrandTotal.toStringAsFixed(2)}',
            style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
          ),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: hasStockIssue || _refreshing
                ? null
                : () async {
                    final ok = await session.refreshCartFromServer();
                    if (!context.mounted) return;
                    if (!ok || session.cart.isEmpty) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        SnackBar(content: Text(s.t('unavailableItem'))),
                      );
                      return;
                    }
                    context.go('/customer/checkout');
                  },
            child: Text(s.t('checkoutAll')),
          ),
        ],
      ],
    );
  }
}

class CheckoutScreen extends StatefulWidget {
  const CheckoutScreen({super.key});

  @override
  State<CheckoutScreen> createState() => _CheckoutScreenState();
}

enum _CheckoutPayMethod { card, payOnDelivery }

class _CheckoutScreenState extends State<CheckoutScreen> {
  int step = 0;
  bool _paying = false;
  String? _payError;
  _CheckoutPayMethod _payMethod = _CheckoutPayMethod.card;
  late final TextEditingController _city;
  late final TextEditingController _address;

  @override
  void initState() {
    super.initState();
    final session = context.read<AppSession>();
    _city = TextEditingController(text: session.city);
    _address = TextEditingController(text: session.addressLine);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(context.read<AppSession>().refreshCartFromServer());
    });
  }

  @override
  void dispose() {
    _city.dispose();
    _address.dispose();
    super.dispose();
  }

  Future<void> _saveAddressStep() async {
    final session = context.read<AppSession>();
    final api = context.read<ApiClient>();
    final city = _city.text.trim();
    final address = _address.text.trim();
    if (city.isEmpty || address.isEmpty) {
      setState(() => _payError = 'City and address are required');
      return;
    }
    if (session.accessToken != null && session.apiOnline) {
      await api.updateProfile(
        name: session.displayName,
        phone: session.phone.isEmpty ? '—' : session.phone,
        city: city,
        addressLine: address,
      );
    } else {
      session.applyProfile(
        name: session.displayName,
        phoneNumber: session.phone,
        cityName: city,
        address: address,
      );
    }
    setState(() {
      _payError = null;
      step = 2;
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final session = context.watch<AppSession>();
    final steps = [s.t('review'), s.t('address'), s.t('delivery'), s.t('payment'), s.t('confirmation')];

    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text(s.t('checkout'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
        const SizedBox(height: 16),
        Wrap(
          spacing: 8,
          children: [
            for (var i = 0; i < steps.length; i++)
              ActionChip(
                label: Text(steps[i]),
                backgroundColor: i == step ? WingerColors.brand : WingerColors.brandMuted,
                labelStyle: TextStyle(
                  color: i == step ? Colors.white : WingerColors.ink,
                  fontWeight: FontWeight.w700,
                ),
                onPressed: _paying || i >= step || step >= 4
                    ? null
                    : () => setState(() {
                          _payError = null;
                          step = i;
                        }),
              ),
          ],
        ),
        const SizedBox(height: 20),
        if (step < 4) ...[
          if (step == 0) ...[
            Text(
              'Review ${session.cartCount} item${session.cartCount == 1 ? '' : 's'} '
              'from ${session.cartBySupplier.length} supplier'
              '${session.cartBySupplier.length == 1 ? '' : 's'}.',
              style: TextStyle(color: WingerColors.muted),
            ),
            const SizedBox(height: 12),
            if (session.cart.isEmpty)
              Text(
                'Your cart is empty.',
                style: TextStyle(color: WingerColors.muted),
              )
            else ...[
              for (final entry in session.cartBySupplier.entries) ...[
                Text(
                  entry.key,
                  style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16),
                ),
                const SizedBox(height: 8),
                for (final item in entry.value)
                  Card(
                    child: ListTile(
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 4,
                      ),
                      leading: ClipRRect(
                        borderRadius: BorderRadius.circular(8),
                        child: Image.network(
                          item.product.imageUrl,
                          width: 52,
                          height: 52,
                          fit: BoxFit.cover,
                          errorBuilder: (_, __, ___) => Container(
                            width: 52,
                            height: 52,
                            color: WingerColors.brandMuted,
                            child: const Icon(Icons.image_outlined),
                          ),
                        ),
                      ),
                      title: Text(
                        item.product.name,
                        style: const TextStyle(fontWeight: FontWeight.w700),
                      ),
                      subtitle: Text(
                        '\$${item.product.price.toStringAsFixed(2)} × ${item.quantity}',
                      ),
                      trailing: Text(
                        '\$${item.lineTotal.toStringAsFixed(2)}',
                        style: const TextStyle(fontWeight: FontWeight.w800),
                      ),
                    ),
                  ),
                const SizedBox(height: 12),
              ],
              Align(
                alignment: Alignment.centerRight,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Text(
                      '${s.t('subtotal')}: \$${session.cartTotal.toStringAsFixed(2)}',
                      style: TextStyle(color: WingerColors.muted),
                    ),
                    Text(
                      '${s.t('deliveryFee')}: \$${session.cartDeliveryFee.toStringAsFixed(2)}',
                      style: TextStyle(color: WingerColors.muted),
                    ),
                    Text(
                      '${s.t('estimatedTax')}: \$${session.cartTax.toStringAsFixed(2)}',
                      style: TextStyle(color: WingerColors.muted),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '${s.t('dueToday')}: \$${session.cartGrandTotal.toStringAsFixed(2)}',
                      style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
                    ),
                  ],
                ),
              ),
            ],
          ]
          else if (step == 1) ...[
            Text(s.t('deliveryAddress'), style: const TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            TextField(
              controller: _address,
              decoration: InputDecoration(
                labelText: s.t('addressLine'),
                hintText: 'Westlands',
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _city,
              decoration: InputDecoration(labelText: s.t('obCity')),
            ),
            const SizedBox(height: 8),
            Text(
              '${s.t('deliveryTo')}: ${session.displayName}',
              style: TextStyle(color: WingerColors.muted),
            ),
          ]
          else if (step == 2) ...[
            Text(
              'Deliver to ${session.city} · ${session.addressLine} · ${session.displayName}',
            ),
            const SizedBox(height: 16),
            Text(
              s.t('fulfillMethod'),
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final option in const [
                  ('express', 'Express 1–2 days'),
                  ('standard', 'Standard 3–5 days'),
                  ('pickup', 'Pickup'),
                ])
                  ChoiceChip(
                    label: Text(option.$2),
                    selected: session.deliveryMethod == option.$1,
                    selectedColor: WingerColors.brandMuted,
                    onSelected: (_) async {
                      session.setDeliveryMethod(option.$1);
                      await session.refreshCartFromServer();
                    },
                  ),
              ],
            ),
            const SizedBox(height: 12),
            Text(s.t('shipments'), style: const TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            for (final shipment in session.cartShipments)
              Card(
                child: ListTile(
                  title: Text(shipment.supplierName, style: const TextStyle(fontWeight: FontWeight.w700)),
                  subtitle: Text(
                    '${shipment.estimate}\n'
                    '${s.t('deliveryFee')}: \$${shipment.fee.toStringAsFixed(2)}'
                    '${session.deliveryMethod == 'pickup' ? '' : ' (${s.t('perSupplierFee')})'}',
                  ),
                  isThreeLine: true,
                ),
              ),
            const SizedBox(height: 8),
            Text(
              '${s.t('deliveryFee')}: \$${session.cartDeliveryFee.toStringAsFixed(2)} · '
              '${s.t('estimatedTax')}: \$${session.cartTax.toStringAsFixed(2)}',
              style: TextStyle(color: WingerColors.muted),
            ),
            Text(
              '${s.t('dueToday')}: \$${session.cartGrandTotal.toStringAsFixed(2)}',
              style: const TextStyle(fontWeight: FontWeight.w800),
            ),
          ]
          else ...[
            Text(
              s.t('paymentMethod'),
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 12),
            SegmentedButton<_CheckoutPayMethod>(
              segments: [
                ButtonSegment(
                  value: _CheckoutPayMethod.card,
                  label: Text(s.t('payByCard')),
                  icon: const Icon(Icons.credit_card_outlined),
                ),
                ButtonSegment(
                  value: _CheckoutPayMethod.payOnDelivery,
                  label: Text(s.t('payOnDelivery')),
                  icon: const Icon(Icons.payments_outlined),
                ),
              ],
              selected: {_payMethod},
              onSelectionChanged: (value) {
                setState(() => _payMethod = value.first);
              },
            ),
            const SizedBox(height: 16),
            Text(
              _payMethod == _CheckoutPayMethod.payOnDelivery
                  ? '${s.t('payOnDeliveryHint')}\n'
                      '\$${session.cartGrandTotal.toStringAsFixed(2)} · ${session.addressLine}, ${session.city}'
                  : session.apiOnline && session.accessToken != null
                      ? 'Pay \$${session.cartGrandTotal.toStringAsFixed(2)} by card '
                          '(API · demo payment unless Stripe key set)\n'
                          'Ship to ${session.addressLine}, ${session.city}'
                      : 'Pay \$${session.cartGrandTotal.toStringAsFixed(2)} offline — '
                          'order saved locally until online',
            ),
          ],
          if (_payError != null) ...[
            const SizedBox(height: 12),
            Text(_payError!, style: const TextStyle(color: WingerColors.dangerInk)),
          ],
          const SizedBox(height: 20),
          Row(
            children: [
              if (step > 0) ...[
                OutlinedButton(
                  onPressed: _paying
                      ? null
                      : () => setState(() {
                            _payError = null;
                            step--;
                          }),
                  child: Text(s.t('back')),
                ),
                const SizedBox(width: 12),
              ],
              Expanded(
                child: FilledButton(
                  onPressed: _paying
                      ? null
                      : () async {
                          if (step == 1) {
                            setState(() => _paying = true);
                            try {
                              await _saveAddressStep();
                            } catch (error) {
                              if (!mounted) return;
                              setState(() => _payError = error.toString());
                            } finally {
                              if (mounted) setState(() => _paying = false);
                            }
                            return;
                          }
                          if (step < 3) {
                            setState(() => step++);
                            return;
                          }
                          setState(() {
                            _paying = true;
                            _payError = null;
                          });
                          try {
                            final offline =
                                !session.apiOnline || session.accessToken == null;
                            final method =
                                _payMethod == _CheckoutPayMethod.payOnDelivery
                                    ? 'pay_on_delivery'
                                    : 'card';
                            final order =
                                await session.placeOrder(paymentMethod: method);
                            if (!mounted) return;
                            final messenger = ScaffoldMessenger.of(context);
                            if (offline) {
                              messenger.showSnackBar(
                                SnackBar(
                                  content: Text(
                                    method == 'pay_on_delivery'
                                        ? 'Order saved locally — pay on delivery when connected.'
                                        : 'Order saved locally — waiting for connection to charge payment.',
                                  ),
                                ),
                              );
                            } else {
                              messenger.showSnackBar(
                                SnackBar(
                                  content: Text(
                                    '${order.id} · ${order.paymentMode} · ${order.paymentStatus}',
                                  ),
                                ),
                              );
                            }
                            setState(() => step = 4);
                          } catch (error) {
                            if (!mounted) return;
                            setState(() => _payError = error.toString());
                          } finally {
                            if (mounted) setState(() => _paying = false);
                          }
                        },
                  child: _paying
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Colors.white,
                          ),
                        )
                      : Text(
                          step == 3
                              ? (_payMethod == _CheckoutPayMethod.payOnDelivery
                                  ? s.t('placeOrderCod')
                                  : s.t('payment'))
                              : s.t('continueRole'),
                        ),
                ),
              ),
            ],
          ),
        ] else ...[
          const Icon(Icons.check_circle, color: WingerColors.successInk, size: 64),
          const SizedBox(height: 12),
          Text(s.t('thanksOrder'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
          Text('${s.t('orderConfirmed')} · ${session.lastOrder?.id ?? 'WG-10025'}'),
          Text(
            session.lastOrder?.paymentMode == 'cod'
                ? '${s.t('payOnDelivery')}: ${session.lastOrder?.paymentStatus ?? 'PENDING'}'
                : 'Payment: ${session.lastOrder?.paymentStatus ?? 'PAID'} (${session.lastOrder?.paymentMode ?? 'demo'})',
            style: const TextStyle(color: WingerColors.muted),
          ),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: () => context.go('/customer/orders'),
            child: Text(s.t('trackOrder')),
          ),
        ],
      ],
    );
  }
}

class OrdersScreen extends StatefulWidget {
  const OrdersScreen({super.key});

  @override
  State<OrdersScreen> createState() => _OrdersScreenState();
}

class _OrdersScreenState extends State<OrdersScreen> {
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
    if (session.lastOrder != null) return [session.lastOrder!];
    return [MockCatalog.sampleOrder];
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
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (orders.isEmpty) {
          return ListView(
            padding: const EdgeInsets.all(20),
            children: [
              Text(s.t('orders'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
              const SizedBox(height: 12),
              Text('No orders yet.', style: TextStyle(color: WingerColors.muted)),
            ],
          );
        }

        return ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Text(s.t('orders'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: 12),
            for (final order in orders) ...[
              Card(
                child: InkWell(
                  onTap: () => context.go('/customer/orders/${order.id}'),
                  borderRadius: BorderRadius.circular(12),
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Text(order.id, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
                            const SizedBox(width: 12),
                            StatusBadge(status: order.status),
                            const Spacer(),
                            Text('\$${order.total.toStringAsFixed(2)}', style: const TextStyle(fontWeight: FontWeight.w800)),
                          ],
                        ),
                        const SizedBox(height: 4),
                        Text(
                          '${order.paymentStatus} · ${order.paymentMode}',
                          style: TextStyle(color: WingerColors.muted),
                        ),
                        if (order.isReplacementOrder) ...[
                          const SizedBox(height: 4),
                          Text(
                            s
                                .t('replacementForOrder')
                                .replaceAll(
                                  '{id}',
                                  order.replacesOrderIds.join(', '),
                                ),
                            style: const TextStyle(
                              color: WingerColors.successInk,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ],
                        if (order.replacedByOrderIds.isNotEmpty) ...[
                          const SizedBox(height: 4),
                          Text(
                            s
                                .t('replacementOrderCreated')
                                .replaceAll(
                                  '{id}',
                                  order.replacedByOrderIds.join(', '),
                                ),
                            style: const TextStyle(
                              color: WingerColors.infoInk,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ],
                        const SizedBox(height: 4),
                        Text(
                          '${s.t('placedOn')}: ${order.placedAt.toLocal().toString().split('.').first}',
                          style: TextStyle(color: WingerColors.muted, fontSize: 12),
                        ),
                        const SizedBox(height: 12),
                        for (final leg in order.shipments.take(2))
                          Padding(
                            padding: const EdgeInsets.only(bottom: 6),
                            child: Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    '${leg.supplierName} · ${leg.productName}',
                                    style: const TextStyle(fontWeight: FontWeight.w600),
                                  ),
                                ),
                                StatusBadge(status: leg.status),
                              ],
                            ),
                          ),
                        if (order.shipments.length > 2)
                          Text(
                            '+${order.shipments.length - 2} more',
                            style: TextStyle(color: WingerColors.muted, fontSize: 12),
                          ),
                        const SizedBox(height: 4),
                        Align(
                          alignment: Alignment.centerRight,
                          child: Text(
                            s.t('orderDetails'),
                            style: const TextStyle(
                              color: WingerColors.brand,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 8),
            ],
          ],
        );
      },
    );
  }
}

class OrderDetailScreen extends StatefulWidget {
  const OrderDetailScreen({super.key, required this.orderId});

  final String orderId;

  @override
  State<OrderDetailScreen> createState() => _OrderDetailScreenState();
}

class _OrderDetailScreenState extends State<OrderDetailScreen> {
  Future<CustomerOrder>? _future;
  bool _cancelling = false;
  bool _rating = false;
  bool _returning = false;

  static const _returnReasons = <String>[
    'damaged',
    'wrong_item',
    'not_as_described',
    'changed_mind',
    'other',
  ];

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _future ??= _load();
  }

  Future<CustomerOrder> _load() {
    return context.read<ApiClient>().fetchOrder(widget.orderId);
  }

  String _returnReasonLabel(WingerStrings s, String reason) {
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

  Future<void> _requestReturn(CustomerOrder order) async {
    final s = WingerStrings.of(context);
    if (order.returnableItems.isEmpty) return;

    var selectedItem = order.returnableItems.first;
    var reason = _returnReasons.first;
    final notesCtrl = TextEditingController();
    final submitted = await showDialog<bool>(
      context: context,
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setLocal) {
            return AlertDialog(
              title: Text(s.t('requestReturnTitle')),
              content: SizedBox(
                width: 420,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(s.t('requestReturnHint'), style: TextStyle(color: WingerColors.muted)),
                    const SizedBox(height: 12),
                    Text(s.t('returnItem'), style: const TextStyle(fontWeight: FontWeight.w700)),
                    const SizedBox(height: 6),
                    DropdownButtonFormField<String>(
                      value: selectedItem.orderItemId,
                      items: [
                        for (final item in order.returnableItems)
                          DropdownMenuItem(
                            value: item.orderItemId,
                            child: Text(
                              '${item.productName} · ${item.supplierName}',
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                      ],
                      onChanged: (value) {
                        if (value == null) return;
                        setLocal(() {
                          selectedItem = order.returnableItems.firstWhere(
                            (item) => item.orderItemId == value,
                          );
                        });
                      },
                    ),
                    const SizedBox(height: 12),
                    Text(s.t('returnReason'), style: const TextStyle(fontWeight: FontWeight.w700)),
                    const SizedBox(height: 6),
                    DropdownButtonFormField<String>(
                      value: reason,
                      items: [
                        for (final code in _returnReasons)
                          DropdownMenuItem(
                            value: code,
                            child: Text(_returnReasonLabel(s, code)),
                          ),
                      ],
                      onChanged: (value) {
                        if (value == null) return;
                        setLocal(() => reason = value);
                      },
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: notesCtrl,
                      maxLines: 3,
                      decoration: InputDecoration(labelText: s.t('returnNotes')),
                    ),
                  ],
                ),
              ),
              actions: [
                TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text(s.t('back'))),
                FilledButton(
                  onPressed: () => Navigator.pop(ctx, true),
                  child: Text(s.t('submitReturn')),
                ),
              ],
            );
          },
        );
      },
    );
    final notes = notesCtrl.text;
    notesCtrl.dispose();
    if (submitted != true || !mounted) return;

    setState(() => _returning = true);
    try {
      await context.read<ApiClient>().createReturnRequest(
            orderId: order.id,
            orderItemId: selectedItem.orderItemId,
            reason: reason,
            notes: notes,
            quantity: selectedItem.quantity,
          );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(s.t('returnSubmitted'))),
      );
      setState(() => _future = _load());
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(error.toString().replaceFirst('Exception: ', ''))),
      );
    } finally {
      if (mounted) setState(() => _returning = false);
    }
  }

  Future<void> _rateSupplier(CustomerOrder order, RateableSupplier supplier) async {
    final s = WingerStrings.of(context);
    var stars = 5;
    final commentCtrl = TextEditingController();
    final submitted = await showDialog<bool>(
      context: context,
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setLocal) {
            return AlertDialog(
              title: Text(s.t('rateSupplierTitle')),
              content: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(supplier.supplierName, style: const TextStyle(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 8),
                  Text(s.t('rateSupplierHint'), style: TextStyle(color: WingerColors.muted)),
                  const SizedBox(height: 12),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      for (var i = 1; i <= 5; i++)
                        IconButton(
                          onPressed: () => setLocal(() => stars = i),
                          icon: Icon(
                            i <= stars ? Icons.star : Icons.star_border,
                            color: WingerColors.attentionInk,
                          ),
                        ),
                    ],
                  ),
                  TextField(
                    controller: commentCtrl,
                    maxLines: 3,
                    decoration: InputDecoration(labelText: s.t('optionalComment')),
                  ),
                ],
              ),
              actions: [
                TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text(s.t('back'))),
                FilledButton(
                  onPressed: () => Navigator.pop(ctx, true),
                  child: Text(s.t('submitRating')),
                ),
              ],
            );
          },
        );
      },
    );
    final comment = commentCtrl.text;
    commentCtrl.dispose();
    if (submitted != true || !mounted) return;
    setState(() => _rating = true);
    try {
      await context.read<ApiClient>().submitSupplierReview(
            orderId: order.id,
            supplierId: supplier.supplierId,
            rating: stars,
            comment: comment,
          );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(s.t('ratingSubmitted'))),
      );
      setState(() => _future = _load());
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(error.toString().replaceFirst('Exception: ', ''))),
      );
    } finally {
      if (mounted) setState(() => _rating = false);
    }
  }

  Future<void> _cancel(CustomerOrder order) async {
    final s = WingerStrings.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(s.t('cancelOrder')),
        content: Text(s.t('cancelOrderConfirm')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text(s.t('back'))),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: Text(s.t('cancelOrder'))),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _cancelling = true);
    try {
      await context.read<ApiClient>().cancelOrder(order.id);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(s.t('orderCancelled'))),
      );
      setState(() => _future = _load());
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(error.toString().replaceFirst('Exception: ', ''))),
      );
    } finally {
      if (mounted) setState(() => _cancelling = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final future = _future;
    if (future == null) {
      return const Center(child: CircularProgressIndicator());
    }

    return FutureBuilder<CustomerOrder>(
      future: future,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.hasError || snapshot.data == null) {
          return ListView(
            padding: const EdgeInsets.all(20),
            children: [
              TextButton.icon(
                onPressed: () => context.go('/customer/orders'),
                icon: const Icon(Icons.arrow_back),
                label: Text(s.t('orders')),
              ),
              Text(snapshot.error?.toString() ?? 'Order not found'),
            ],
          );
        }
        final order = snapshot.data!;
        final shipmentsBySupplier = <String, List<ShipmentLeg>>{};
        for (final leg in order.shipments) {
          shipmentsBySupplier.putIfAbsent(leg.supplierName, () => []).add(leg);
        }

        return ListView(
          padding: const EdgeInsets.all(20),
          children: [
            TextButton.icon(
              onPressed: () => context.go('/customer/orders'),
              icon: const Icon(Icons.arrow_back),
              label: Text(s.t('orders')),
            ),
            Text(s.t('orderDetails'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: 12),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Text(order.id, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 20)),
                        const SizedBox(width: 12),
                        StatusBadge(status: order.status),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Text('${s.t('placedOn')}: ${order.placedAt.toLocal()}'),
                    Text('${order.paymentStatus} · ${order.paymentMode}${order.paymentMethod != null ? ' · ${order.paymentMethod}' : ''}'),
                    Text('\$${order.total.toStringAsFixed(2)}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
                    if (order.isReplacementOrder) ...[
                      const SizedBox(height: 8),
                      Text(
                        s.t('replacementOrderHint'),
                        style: TextStyle(color: WingerColors.muted),
                      ),
                      const SizedBox(height: 4),
                      for (final originalId in order.replacesOrderIds)
                        TextButton(
                          onPressed: () =>
                              context.go('/customer/orders/$originalId'),
                          child: Text(
                            s
                                .t('replacementForOrder')
                                .replaceAll('{id}', originalId),
                          ),
                        ),
                    ],
                    if (order.replacedByOrderIds.isNotEmpty) ...[
                      const SizedBox(height: 8),
                      for (final replacementId in order.replacedByOrderIds)
                        TextButton(
                          onPressed: () =>
                              context.go('/customer/orders/$replacementId'),
                          child: Text(
                            s
                                .t('replacementOrderCreated')
                                .replaceAll('{id}', replacementId),
                          ),
                        ),
                    ],
                    if (order.addressLine != null || order.city != null) ...[
                      const SizedBox(height: 8),
                      Text(s.t('deliveryAddress'), style: const TextStyle(fontWeight: FontWeight.w700)),
                      Text('${order.addressLine ?? ''} · ${order.city ?? ''}'),
                    ],
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
            Text(s.t('shipments'), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
            const SizedBox(height: 8),
            for (final entry in shipmentsBySupplier.entries) ...[
              Text(entry.key, style: const TextStyle(fontWeight: FontWeight.w700)),
              const SizedBox(height: 6),
              for (final leg in entry.value)
                Card(
                  child: ListTile(
                    title: Text(leg.productName),
                    subtitle: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (leg.trackingCode != null)
                          Text('${s.t('trackingCode')}: ${leg.trackingCode}'),
                        if (leg.pickupCode != null)
                          Text('${s.t('pickupCode')}: ${leg.pickupCode}'),
                        if (leg.trackingCode == null && leg.pickupCode == null)
                          Text(s.t('fulfillment'), style: TextStyle(color: WingerColors.muted)),
                      ],
                    ),
                    trailing: StatusBadge(status: leg.status),
                  ),
                ),
              const SizedBox(height: 12),
            ],
            Text(s.t('supportHint'), style: TextStyle(color: WingerColors.muted)),
            if (order.canRequestReturn) ...[
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: _returning ? null : () => _requestReturn(order),
                icon: _returning
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                      )
                    : const Icon(Icons.assignment_return_outlined),
                label: Text(s.t('requestReturn')),
              ),
            ],
            if (order.returnRequests.isNotEmpty) ...[
              const SizedBox(height: 16),
              Text(s.t('returnRequests'), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
              const SizedBox(height: 8),
              for (final request in order.returnRequests)
                Card(
                  child: ListTile(
                    leading: const Icon(Icons.assignment_return_outlined),
                    title: Text(request.productName),
                    subtitle: Text(
                      '${request.supplierName}\n'
                      '${_returnReasonLabel(s, request.reason)}'
                      '${request.notes != null && request.notes!.isNotEmpty ? ' · ${request.notes}' : ''}',
                    ),
                    isThreeLine: true,
                    trailing: Text(
                      '${s.t('returnStatus')}: ${request.status}\n'
                      '${s.t('refundStatus')}: ${request.refundStatus}',
                      textAlign: TextAlign.end,
                      style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 12),
                    ),
                  ),
                ),
            ],
            if (order.canRateSuppliers.isNotEmpty) ...[
              const SizedBox(height: 16),
              Text(s.t('rateSupplier'), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
              const SizedBox(height: 8),
              for (final supplier in order.canRateSuppliers)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: FilledButton.tonalIcon(
                    onPressed: _rating ? null : () => _rateSupplier(order, supplier),
                    icon: const Icon(Icons.star_outline),
                    label: Text('${s.t('rateSupplier')}: ${supplier.supplierName}'),
                  ),
                ),
            ],
            const SizedBox(height: 16),
            if (order.canCancel)
              OutlinedButton(
                onPressed: _cancelling ? null : () => _cancel(order),
                child: _cancelling
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Text(s.t('cancelOrder')),
              ),
          ],
        );
      },
    );
  }
}

class CustomerAccountScreen extends StatefulWidget {
  const CustomerAccountScreen({super.key});

  @override
  State<CustomerAccountScreen> createState() => _CustomerAccountScreenState();
}

class _CustomerAccountScreenState extends State<CustomerAccountScreen> {
  late final TextEditingController _name;
  late final TextEditingController _phone;
  late final TextEditingController _city;
  late final TextEditingController _address;
  bool _busy = false;
  String? _message;
  String? _error;

  @override
  void initState() {
    super.initState();
    final session = context.read<AppSession>();
    _name = TextEditingController(text: session.displayName);
    _phone = TextEditingController(text: session.phone);
    _city = TextEditingController(text: session.city);
    _address = TextEditingController(text: session.addressLine);
    _load();
  }

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _city.dispose();
    _address.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final api = context.read<ApiClient>();
    final session = context.read<AppSession>();
    if (session.accessToken == null) return;
    await api.refreshProfile();
    if (!mounted) return;
    setState(() {
      _name.text = session.displayName;
      _phone.text = session.phone;
      _city.text = session.city;
      _address.text = session.addressLine;
    });
  }

  Future<void> _save() async {
    final api = context.read<ApiClient>();
    final session = context.read<AppSession>();
    setState(() {
      _busy = true;
      _error = null;
      _message = null;
    });
    try {
      if (session.accessToken != null && session.apiOnline) {
        await api.updateProfile(
          name: _name.text.trim(),
          phone: _phone.text.trim(),
          city: _city.text.trim(),
          addressLine: _address.text.trim(),
        );
      } else {
        session.applyProfile(
          name: _name.text.trim(),
          phoneNumber: _phone.text.trim(),
          cityName: _city.text.trim(),
          address: _address.text.trim(),
        );
      }
      if (!mounted) return;
      setState(() => _message = 'Profile saved');
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final session = context.watch<AppSession>();
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text(s.t('account'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
        Text(session.email, style: const TextStyle(color: WingerColors.muted)),
        const SizedBox(height: 20),
        Text(s.t('obCustomerProfile'), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
        const SizedBox(height: 8),
        TextField(controller: _name, decoration: InputDecoration(labelText: s.t('obName'))),
        const SizedBox(height: 8),
        TextField(controller: _phone, decoration: InputDecoration(labelText: s.t('obPhone'))),
        const SizedBox(height: 8),
        TextField(
          controller: _address,
          decoration: InputDecoration(
            labelText: s.t('addressLine'),
            hintText: 'Westlands',
          ),
        ),
        const SizedBox(height: 8),
        TextField(controller: _city, decoration: InputDecoration(labelText: s.t('obCity'))),
        if (_error != null) ...[
          const SizedBox(height: 8),
          Text(_error!, style: const TextStyle(color: WingerColors.dangerInk)),
        ],
        if (_message != null) ...[
          const SizedBox(height: 8),
          Text(_message!, style: const TextStyle(color: WingerColors.successInk)),
        ],
        const SizedBox(height: 12),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: _busy
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                )
              : Text(s.t('obSaveProfile')),
        ),
        const SizedBox(height: 24),
        ListTile(
          leading: const Icon(Icons.notifications_outlined),
          title: Text(s.t('notifications')),
          subtitle: Text(
            s.t('notificationsHint'),
            style: const TextStyle(color: WingerColors.muted),
          ),
          onTap: () => context.go('/customer/notifications'),
        ),
        ListTile(
          leading: const Icon(Icons.location_on_outlined),
          title: Text(s.t('addresses')),
          subtitle: Text(
            '${session.addressLine}, ${session.city}',
            style: TextStyle(color: WingerColors.muted),
          ),
          onTap: () => context.go('/customer/addresses'),
        ),
        ListTile(
          leading: const Icon(Icons.receipt_long_outlined),
          title: Text(s.t('orders')),
          onTap: () => context.go('/customer/orders'),
        ),
        ListTile(
          leading: const Icon(Icons.favorite_border),
          title: Text(s.t('wishlist')),
          trailing: Text('${session.wishlistIds.length}'),
          onTap: () => context.go('/customer/wishlist'),
        ),
        ListTile(
          leading: const Icon(Icons.history),
          title: Text(s.t('recentlyViewed')),
          trailing: Text('${session.recentlyViewedIds.length}'),
          onTap: () => context.go('/customer/recent'),
        ),
        ListTile(
          leading: const Icon(Icons.shopping_cart_outlined),
          title: Text(s.t('cart')),
          trailing: Text('${session.cartCount}'),
          onTap: () => context.go('/customer/cart'),
        ),
        ListTile(
          leading: const Icon(Icons.support_agent),
          title: Text(s.t('support')),
          subtitle: Text(s.t('supportHint')),
        ),
        ListTile(
          leading: const Icon(Icons.logout),
          title: Text(s.t('signOut')),
          onTap: () {
            session.signOut();
            context.go('/login');
          },
        ),
      ],
    );
  }
}

class AddressesScreen extends StatefulWidget {
  const AddressesScreen({super.key});

  @override
  State<AddressesScreen> createState() => _AddressesScreenState();
}

class _AddressesScreenState extends State<AddressesScreen> {
  late final TextEditingController _address;
  late final TextEditingController _city;
  bool _busy = false;
  String? _message;
  String? _error;

  @override
  void initState() {
    super.initState();
    final session = context.read<AppSession>();
    _address = TextEditingController(text: session.addressLine);
    _city = TextEditingController(text: session.city);
  }

  @override
  void dispose() {
    _address.dispose();
    _city.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final api = context.read<ApiClient>();
    final session = context.read<AppSession>();
    final address = _address.text.trim();
    final city = _city.text.trim();
    if (address.isEmpty || city.isEmpty) {
      setState(() => _error = 'Address and city are required');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
      _message = null;
    });
    try {
      if (session.accessToken != null && session.apiOnline) {
        await api.updateProfile(
          name: session.displayName,
          phone: session.phone,
          city: city,
          addressLine: address,
        );
      } else {
        session.applyProfile(
          name: session.displayName,
          phoneNumber: session.phone,
          cityName: city,
          address: address,
        );
      }
      if (!mounted) return;
      setState(() => _message = WingerStrings.of(context).t('addressSaved'));
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        TextButton.icon(
          onPressed: () => context.go('/customer/account'),
          icon: const Icon(Icons.arrow_back),
          label: Text(s.t('account')),
        ),
        Text(
          s.t('addresses'),
          style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
        ),
        const SizedBox(height: 8),
        Text(s.t('deliveryAddress'), style: TextStyle(color: WingerColors.muted)),
        const SizedBox(height: 16),
        TextField(
          controller: _address,
          decoration: InputDecoration(
            labelText: s.t('addressLine'),
            hintText: 'Westlands',
          ),
        ),
        const SizedBox(height: 8),
        TextField(
          controller: _city,
          decoration: InputDecoration(labelText: s.t('obCity')),
        ),
        if (_error != null) ...[
          const SizedBox(height: 8),
          Text(_error!, style: const TextStyle(color: WingerColors.dangerInk)),
        ],
        if (_message != null) ...[
          const SizedBox(height: 8),
          Text(_message!, style: const TextStyle(color: WingerColors.successInk)),
        ],
        const SizedBox(height: 16),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: _busy
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                )
              : Text(s.t('saveAddress')),
        ),
      ],
    );
  }
}

class CustomerNotificationsScreen extends StatefulWidget {
  const CustomerNotificationsScreen({super.key});

  @override
  State<CustomerNotificationsScreen> createState() =>
      _CustomerNotificationsScreenState();
}

class _CustomerNotificationsScreenState
    extends State<CustomerNotificationsScreen> {
  bool _loading = true;
  String? _error;
  int _unreadCount = 0;
  List<CustomerNotification> _items = const [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final api = context.read<ApiClient>();
    final session = context.read<AppSession>();
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      if (session.accessToken == null) {
        setState(() {
          _items = const [];
          _unreadCount = 0;
          _loading = false;
        });
        return;
      }
      final result = await api.fetchNotifications();
      if (!mounted) return;
      setState(() {
        _items = result.items;
        _unreadCount = result.unreadCount;
        _loading = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.toString().replaceFirst('Exception: ', '');
        _loading = false;
      });
    }
  }

  Future<void> _markRead(CustomerNotification item) async {
    if (!item.isUnread) return;
    final api = context.read<ApiClient>();
    try {
      await api.markNotificationRead(item.id);
      await _load();
    } catch (_) {}
  }

  Future<void> _markAllRead() async {
    final api = context.read<ApiClient>();
    try {
      await api.markAllNotificationsRead();
      await _load();
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  s.t('notifications'),
                  style: Theme.of(context)
                      .textTheme
                      .headlineSmall
                      ?.copyWith(fontWeight: FontWeight.w800),
                ),
              ),
              if (_unreadCount > 0)
                TextButton(
                  onPressed: _markAllRead,
                  child: Text(s.t('markAllRead')),
                ),
            ],
          ),
          Text(
            s.t('notificationsHint'),
            style: const TextStyle(color: WingerColors.muted),
          ),
          const SizedBox(height: 16),
          if (_loading)
            const Center(child: CircularProgressIndicator())
          else if (_error != null)
            Text(_error!, style: const TextStyle(color: WingerColors.dangerInk))
          else if (_items.isEmpty)
            Text(
              s.t('noNotifications'),
              style: const TextStyle(color: WingerColors.muted),
            )
          else
            for (final item in _items) ...[
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: Icon(
                  item.isUnread
                      ? Icons.notifications_active
                      : Icons.notifications_none,
                  color: item.isUnread ? WingerColors.brand : WingerColors.muted,
                ),
                title: Text(
                  item.title,
                  style: TextStyle(
                    fontWeight:
                        item.isUnread ? FontWeight.w800 : FontWeight.w600,
                  ),
                ),
                subtitle: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const SizedBox(height: 4),
                    Text(item.body),
                    const SizedBox(height: 4),
                    Text(
                      item.createdAt.toLocal().toString().split('.').first,
                      style: const TextStyle(
                        color: WingerColors.muted,
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
                isThreeLine: true,
                onTap: () => _markRead(item),
              ),
              const Divider(height: 1),
            ],
        ],
      ),
    );
  }
}

class RecentlyViewedScreen extends StatelessWidget {
  const RecentlyViewedScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final session = context.watch<AppSession>();
    final catalog = context.read<CatalogRepository>();
    final wide = MediaQuery.sizeOf(context).width >= 900;

    return FutureBuilder<List<Product>>(
      future: catalog.getProducts(),
      builder: (context, snapshot) {
        final all = snapshot.data ?? const <Product>[];
        final map = {for (final p in all) p.id: p};
        final items = [
          for (final id in session.recentlyViewedIds)
            if (map[id] != null) map[id]!,
        ];
        return ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Text(
              s.t('recentlyViewed'),
              style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 12),
            if (items.isEmpty)
              Text(s.t('recentlyViewedEmpty'), style: TextStyle(color: WingerColors.muted))
            else
              GridView.builder(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                itemCount: items.length,
                gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: wide ? 4 : 2,
                  mainAxisSpacing: 12,
                  crossAxisSpacing: 12,
                  childAspectRatio: wide ? 0.68 : 0.64,
                ),
                itemBuilder: (context, index) {
                  final product = items[index];
                  return ProductCard(
                    product: product,
                    wishlisted: session.isWishlisted(product.id),
                    onWishlist: () => unawaited(session.toggleWishlist(product.id)),
                    onAddToCart: () => unawaited(session.addToCart(product)),
                    onTap: () => context.go('/customer/product/${product.id}'),
                  );
                },
              ),
          ],
        );
      },
    );
  }
}
