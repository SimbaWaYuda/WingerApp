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
import '../../core/widgets/role_shell.dart';
import '../../core/widgets/status_badge.dart';
import '../onboarding/onboarding_checklist.dart';

const customerDestinations = [
  ShellDestination(labelKey: 'home', icon: Icons.home_outlined, path: '/customer'),
  ShellDestination(labelKey: 'search', icon: Icons.search, path: '/customer/search'),
  ShellDestination(labelKey: 'orders', icon: Icons.receipt_long_outlined, path: '/customer/orders'),
  ShellDestination(labelKey: 'account', icon: Icons.person_outline, path: '/customer/account'),
];

class CustomerShell extends StatelessWidget {
  const CustomerShell({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    return RoleShell(
      title: s.t('home'),
      roleLabel: 'Customer',
      destinations: customerDestinations,
      child: child,
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
    final height = wide ? 320.0 : 300.0;
    return SizedBox(
      height: height,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: products.length,
        separatorBuilder: (_, __) => const SizedBox(width: 12),
        itemBuilder: (context, index) {
          final product = products[index];
          return SizedBox(
            width: wide ? 210 : 180,
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

class CustomerSearchScreen extends StatefulWidget {
  const CustomerSearchScreen({
    super.key,
    this.initialCategory,
    this.initialQuery,
  });

  final String? initialCategory;
  final String? initialQuery;

  @override
  State<CustomerSearchScreen> createState() => _CustomerSearchScreenState();
}

class _CustomerSearchScreenState extends State<CustomerSearchScreen> {
  late final TextEditingController _queryCtrl;
  String? _category;
  String _sort = 'relevance';
  bool _inStockOnly = false;
  int _page = 1;
  Future<ProductPage>? _future;
  Future<List<CatalogCategory>>? _categoriesFuture;

  @override
  void initState() {
    super.initState();
    _queryCtrl = TextEditingController(text: widget.initialQuery ?? '');
    _category = widget.initialCategory;
    _categoriesFuture = context.read<CatalogRepository>().getCategories();
    _reload();
  }

  @override
  void dispose() {
    _queryCtrl.dispose();
    super.dispose();
  }

  void _reload() {
    setState(() {
      _future = context.read<CatalogRepository>().browseProducts(
            query: _queryCtrl.text,
            category: _category,
            inStock: _inStockOnly,
            sort: _sort,
            page: _page,
            pageSize: 24,
          );
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final session = context.watch<AppSession>();
    final wide = MediaQuery.sizeOf(context).width >= 900;
    final future = _future;

    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text(s.t('search'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
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
        const SizedBox(height: 12),
        FutureBuilder<List<CatalogCategory>>(
          future: _categoriesFuture,
          builder: (context, snapshot) {
            final categories = snapshot.data ?? const <CatalogCategory>[];
            return Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                FilterChip(
                  label: Text(s.t('allCategories')),
                  selected: _category == null,
                  onSelected: (_) {
                    _category = null;
                    _page = 1;
                    _reload();
                  },
                ),
                for (final category in categories)
                  FilterChip(
                    label: Text(category.name),
                    selected: _category == category.name,
                    onSelected: (_) {
                      _category = category.name;
                      _page = 1;
                      _reload();
                    },
                  ),
              ],
            );
          },
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            FilterChip(
              label: Text(s.t('inStockOnly')),
              selected: _inStockOnly,
              onSelected: (value) {
                _inStockOnly = value;
                _page = 1;
                _reload();
              },
            ),
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
                _sort = value;
                _page = 1;
                _reload();
              },
            ),
            TextButton(
              onPressed: () {
                _queryCtrl.clear();
                _category = null;
                _inStockOnly = false;
                _sort = 'relevance';
                _page = 1;
                _reload();
              },
              child: Text(s.t('clearFilters')),
            ),
          ],
        ),
        const SizedBox(height: 16),
        if (future == null)
          const Center(child: CircularProgressIndicator())
        else
          FutureBuilder<ProductPage>(
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
                        onPressed: () {
                          _queryCtrl.clear();
                          _category = null;
                          _inStockOnly = false;
                          _page = 1;
                          _reload();
                        },
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
          ),
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
  _DeliveryOption? _delivery;
  int _galleryIndex = 0;

  static const _deliveryLabels = <_DeliveryOption, String>{
    _DeliveryOption.express: 'Express 1–2 days',
    _DeliveryOption.standard: 'Standard 3–5 days',
    _DeliveryOption.pickup: 'Pickup',
  };

  @override
  void initState() {
    super.initState();
    _future = context.read<CatalogRepository>().getProduct(widget.productId);
    unawaited(_recordView());
    _future.then((product) {
      if (!mounted) return;
      final catalog = context.read<CatalogRepository>();
      setState(() {
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

  List<String> _galleryUrls(Product product, List<Product> related) {
    final urls = <String>{product.imageUrl};
    for (final item in related) {
      if (urls.length >= 4) break;
      urls.add(item.imageUrl);
    }
    return urls.toList();
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
            final gallery = _galleryUrls(product, related);
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
                ClipRRect(
                  borderRadius: BorderRadius.circular(20),
                  child: AspectRatio(
                    aspectRatio: 1.4,
                    child: Image.network(
                      gallery[safeIndex],
                      fit: BoxFit.cover,
                      errorBuilder: (_, __, ___) => Container(
                        color: WingerColors.brandMuted,
                        alignment: Alignment.center,
                        child: const Icon(Icons.image_outlined),
                      ),
                    ),
                  ),
                ),
                if (gallery.length > 1) ...[
                  const SizedBox(height: 10),
                  SizedBox(
                    height: 64,
                    child: ListView.separated(
                      scrollDirection: Axis.horizontal,
                      itemCount: gallery.length,
                      separatorBuilder: (_, __) => const SizedBox(width: 8),
                      itemBuilder: (context, index) {
                        final selectedThumb = index == safeIndex;
                        return InkWell(
                          onTap: () => setState(() => _galleryIndex = index),
                          child: Container(
                            decoration: BoxDecoration(
                              borderRadius: BorderRadius.circular(10),
                              border: Border.all(
                                color: selectedThumb ? WingerColors.brand : WingerColors.border,
                                width: selectedThumb ? 2 : 1,
                              ),
                            ),
                            child: ClipRRect(
                              borderRadius: BorderRadius.circular(9),
                              child: Image.network(
                                gallery[index],
                                width: 64,
                                height: 64,
                                fit: BoxFit.cover,
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
                Row(
                  children: [
                    Text('${product.supplierName} · ★ ${product.rating}'),
                    if (product.supplierVerified) ...[
                      const SizedBox(width: 6),
                      const Icon(Icons.verified, size: 18, color: WingerColors.brand),
                    ],
                  ],
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
                Text(product.description),
                const SizedBox(height: 20),
                Text(s.t('specifications'), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
                const SizedBox(height: 8),
                _SpecRow(label: s.t('sku'), value: product.model),
                _SpecRow(label: 'Category', value: product.category),
                _SpecRow(label: 'Color', value: product.color),
                _SpecRow(label: 'Size', value: product.size),
                _SpecRow(label: 'Battery', value: product.battery),
                _SpecRow(label: 'Weight', value: product.weight),
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
                          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(s.t('addToCart'))));
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
                          final messenger = ScaffoldMessenger.of(context);
                          messenger.showSnackBar(
                            SnackBar(
                              content: Text(
                                session.compareIds.length < 2
                                    ? 'Only one ${product.model} offer found — add another supplier from Search'
                                    : 'Comparing ${session.compareIds.length} ${product.model} offers',
                              ),
                              action: SnackBarAction(
                                label: s.t('compare'),
                                onPressed: () => context.go('/customer/compare'),
                              ),
                            ),
                          );
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
          Text('${s.t('deliveryFee')}: \$0.00', style: TextStyle(color: WingerColors.muted)),
          Text('${s.t('tax')}: \$0.00', style: TextStyle(color: WingerColors.muted)),
          const SizedBox(height: 4),
          Text('${s.t('dueToday')}: \$${session.cartTotal.toStringAsFixed(2)}',
              style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
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
                child: Text(
                  '${s.t('dueToday')}: \$${session.cartTotal.toStringAsFixed(2)}',
                  style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
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
                    onSelected: (_) => session.setDeliveryMethod(option.$1),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              'Selected: ${session.deliveryMethodLabel}',
              style: TextStyle(color: WingerColors.muted),
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
                      '\$${session.cartTotal.toStringAsFixed(2)} · ${session.addressLine}, ${session.city}'
                  : session.apiOnline && session.accessToken != null
                      ? 'Pay \$${session.cartTotal.toStringAsFixed(2)} by card '
                          '(API · demo payment unless Stripe key set)\n'
                          'Ship to ${session.addressLine}, ${session.city}'
                      : 'Pay \$${session.cartTotal.toStringAsFixed(2)} offline — '
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
                      const SizedBox(height: 12),
                      for (final leg in order.shipments)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 8),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
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
                              if (leg.trackingCode != null) ...[
                                const SizedBox(height: 2),
                                Text(
                                  '${s.t('trackingCode')}: ${leg.trackingCode}',
                                  style: TextStyle(color: WingerColors.muted, fontSize: 12),
                                ),
                              ],
                              if (leg.pickupCode != null) ...[
                                const SizedBox(height: 2),
                                Text(
                                  '${s.t('pickupCode')}: ${leg.pickupCode}',
                                  style: TextStyle(color: WingerColors.muted, fontSize: 12),
                                ),
                              ],
                            ],
                          ),
                        ),
                    ],
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
          leading: const Icon(Icons.favorite_border),
          title: Text(s.t('wishlist')),
          trailing: Text('${session.wishlistIds.length}'),
          onTap: () => context.go('/customer/wishlist'),
        ),
        ListTile(leading: const Icon(Icons.notifications_none), title: Text(s.t('notifications'))),
        ListTile(leading: const Icon(Icons.support_agent), title: Text(s.t('support'))),
        ListTile(
          leading: const Icon(Icons.shopping_cart_outlined),
          title: Text(s.t('cart')),
          trailing: Text('${session.cartCount}'),
          onTap: () => context.go('/customer/cart'),
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
