import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../l10n/winger_strings.dart';
import '../models/models.dart';
import '../state/app_session.dart';
import '../theme/winger_colors.dart';
import '../theme/winger_tokens.dart';
import 'product_photo.dart';

/// How many catalogue cards fit across the space the grid actually has.
int productGridColumns(double maxWidth) {
  if (maxWidth >= 1280) return 5;
  if (maxWidth >= 980) return 4;
  if (maxWidth >= 680) return 3;
  return 2;
}

/// Card height: 4:5 photo plus compact title/price/meta block.
double productCardHeight(double cardWidth) {
  final imageHeight = cardWidth / WingerLayout.productImageAspectRatio;
  return imageHeight + 148;
}

SliverGridDelegate productGridDelegate(double maxWidth) {
  final columns = productGridColumns(maxWidth);
  final gap = WingerSpacing.s12;
  final cardWidth = (maxWidth - gap * (columns - 1)) / columns;
  return SliverGridDelegateWithFixedCrossAxisCount(
    crossAxisCount: columns,
    mainAxisSpacing: gap,
    crossAxisSpacing: gap,
    childAspectRatio: cardWidth / productCardHeight(cardWidth),
  );
}

void openProduct(
  BuildContext context,
  String id, {
  String? color,
  String? size,
}) {
  final params = <String, String>{
    if ((color ?? '').trim().isNotEmpty) 'color': color!.trim(),
    if ((size ?? '').trim().isNotEmpty) 'size': size!.trim(),
  };
  final uri = Uri(
    path: '/customer/product/$id',
    queryParameters: params.isEmpty ? null : params,
  );
  context.go(uri.toString());
}

Color catalogSwatchColor(String name, {String? hex}) {
  final raw = (hex ?? '').trim();
  if (raw.startsWith('#') && (raw.length == 7 || raw.length == 9)) {
    final value = int.tryParse(raw.substring(1), radix: 16);
    if (value != null) {
      return Color(raw.length == 7 ? (0xFF000000 | value) : value);
    }
  }
  return switch (name.trim().toLowerCase()) {
    'black' => const Color(0xFF1A1A1A),
    'white' => const Color(0xFFF7F7F7),
    'nude' || 'beige' || 'cream' => const Color(0xFFE4C7B0),
    'pink' || 'light pink' => const Color(0xFFF4A7C3),
    'red' => const Color(0xFFC62828),
    'blue' || 'navy' => const Color(0xFF1D4E89),
    'green' || 'dark green' => const Color(0xFF1F4D43),
    'yellow' || 'gold' => const Color(0xFFE0B84F),
    'brown' || 'tan' => const Color(0xFF8D6E63),
    'grey' || 'gray' || 'graphite' || 'silver' => const Color(0xFF8A8A8A),
    'orange' => const Color(0xFFEF6C00),
    'purple' => const Color(0xFF6A1B9A),
    _ => const Color(0xFFD7DDD9),
  };
}

bool productCardSupportsHover() {
  if (kIsWeb) return true;
  return switch (defaultTargetPlatform) {
    TargetPlatform.windows ||
    TargetPlatform.linux ||
    TargetPlatform.macOS =>
      true,
    _ => false,
  };
}

typedef ProductOptionAction = void Function({
  String? variantId,
  String? color,
  String? size,
});

class ProductCard extends StatefulWidget {
  const ProductCard({
    super.key,
    required this.product,
    required this.onTap,
    this.onCompare,
    this.compareSelected = false,
    this.onWishlist,
    this.wishlisted = false,
    this.onAddToCart,
  });

  final Product product;
  final ProductOptionAction onTap;
  final VoidCallback? onCompare;
  final bool compareSelected;
  final VoidCallback? onWishlist;
  final bool wishlisted;
  final ProductOptionAction? onAddToCart;

  @override
  State<ProductCard> createState() => _ProductCardState();
}

class _ProductCardState extends State<ProductCard> {
  String? _color;
  String? _size;
  bool _hovered = false;
  bool _focused = false;

  @override
  void initState() {
    super.initState();
    _applyDefaults();
  }

  @override
  void didUpdateWidget(covariant ProductCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.product.id != widget.product.id) {
      _color = null;
      _size = null;
      _applyDefaults();
    }
  }

  void _applyDefaults() {
    final colors = widget.product.selectableColors;
    final sizes = widget.product.selectableSizes;
    _color = colors.isEmpty ? null : colors.first;
    _size = _firstSizeFor(_color, sizes);
  }

  String? _firstSizeFor(String? color, List<String> sizes) {
    if (sizes.isEmpty) return null;
    final product = widget.product;
    if (!product.hasVariants || (color ?? '').isEmpty) return sizes.first;
    for (final size in sizes) {
      final row = product.variantFor(color: color!, size: size);
      if (row != null && row.stock > 0) return size;
    }
    for (final size in sizes) {
      if (product.variantFor(color: color!, size: size) != null) return size;
    }
    return sizes.first;
  }

  String _photoUrl() {
    final urls = widget.product.galleryUrlsForColor(_color);
    if (urls.isNotEmpty) return urls.first;
    return widget.product.imageUrl;
  }

  void _emit(ProductOptionAction action) {
    final product = widget.product;
    final color = meaningfulSpec(_color);
    final size = meaningfulSpec(_size);
    final variant = product.hasVariants
        ? product.variantFor(color: color ?? '', size: size ?? '')
        : null;
    action(
      variantId: variant?.id,
      color: color,
      size: size,
    );
  }

  String _stockLabel(WingerStrings s, Product product) {
    switch (product.stockStatus) {
      case StockStatus.outOfStock:
        return s.t('outOfStock');
      case StockStatus.lowStock:
        return s.t('lowStock');
      case StockStatus.inStock:
        return s.t('inStock');
    }
  }

  bool get _showQuickAdd {
    if (widget.onAddToCart == null) return false;
    if (widget.product.stockStatus == StockStatus.outOfStock) return false;
    if (!productCardSupportsHover()) return false;
    return _hovered || _focused;
  }

  @override
  Widget build(BuildContext context) {
    final s = WingerStrings.of(context);
    final session = context.watch<AppSession>();
    final product = widget.product;
    final hasPromo =
        product.previousPrice != null && product.previousPrice! > product.price;
    final showRating = product.rating > 0;
    final radius = BorderRadius.circular(WingerRadius.card);

    return FocusableActionDetector(
      onShowFocusHighlight: (focused) => setState(() => _focused = focused),
      child: MouseRegion(
        onEnter: productCardSupportsHover()
            ? (_) => setState(() => _hovered = true)
            : null,
        onExit: productCardSupportsHover()
            ? (_) => setState(() => _hovered = false)
            : null,
        child: Material(
          color: WingerColors.bgSurface,
          elevation: 0,
          shape: RoundedRectangleBorder(
            borderRadius: radius,
            side: BorderSide(color: WingerColors.borderSubtle),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: () => _emit(widget.onTap),
            borderRadius: radius,
            focusColor: WingerColors.focusRing.withValues(alpha: 0.08),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Stack(
                  children: [
                    AspectRatio(
                      aspectRatio: WingerLayout.productImageAspectRatio,
                      child: ProductPhoto(
                        url: _photoUrl(),
                        semanticLabel: product.name,
                      ),
                    ),
                    if (widget.onWishlist != null)
                      Positioned(
                        top: WingerSpacing.s8,
                        right: WingerSpacing.s8,
                        child: Material(
                          color: WingerColors.bgSurface.withValues(alpha: 0.94),
                          shape: const CircleBorder(),
                          child: IconButton(
                            tooltip: s.t('wishlist'),
                            constraints: const BoxConstraints.tightFor(
                              width: 40,
                              height: 40,
                            ),
                            padding: EdgeInsets.zero,
                            onPressed: widget.onWishlist,
                            icon: Icon(
                              widget.wishlisted
                                  ? Icons.favorite
                                  : Icons.favorite_border,
                              color: widget.wishlisted
                                  ? WingerColors.dangerInk
                                  : WingerColors.inkMuted,
                              size: 20,
                            ),
                          ),
                        ),
                      ),
                    if (hasPromo)
                      Positioned(
                        top: WingerSpacing.s8,
                        left: WingerSpacing.s8,
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 8,
                            vertical: 4,
                          ),
                          decoration: BoxDecoration(
                            color: WingerColors.attention,
                            borderRadius: BorderRadius.circular(WingerRadius.chip),
                          ),
                          child: Text(
                            s.t('onSale'),
                            style: TextStyle(
                              color: WingerColors.attentionInk,
                              fontWeight: FontWeight.w700,
                              fontSize: 11,
                            ),
                          ),
                        ),
                      ),
                    if (_showQuickAdd)
                      Positioned(
                        left: WingerSpacing.s8,
                        right: WingerSpacing.s8,
                        bottom: WingerSpacing.s8,
                        child: FilledButton.icon(
                          onPressed: () => _emit(widget.onAddToCart!),
                          icon: const Icon(Icons.add_shopping_cart_outlined, size: 18),
                          label: Text(s.t('addToCart')),
                          style: FilledButton.styleFrom(
                            minimumSize: const Size(64, 40),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(
                                WingerRadius.control,
                              ),
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(
                      WingerSpacing.s12,
                      WingerSpacing.s8,
                      WingerSpacing.s12,
                      WingerSpacing.s12,
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (product.brand.trim().isNotEmpty)
                          Text(
                            product.brand,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.labelSmall,
                          ),
                        Text(
                          product.name,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.titleSmall?.copyWith(
                                fontWeight: FontWeight.w600,
                                height: 1.2,
                                color: WingerColors.inkStrong,
                              ),
                        ),
                        const Spacer(),
                        Row(
                          children: [
                            if (showRating) ...[
                              const Icon(
                                Icons.star_rounded,
                                size: 16,
                                color: Color(0xFFE0A800),
                              ),
                              const SizedBox(width: 2),
                              Text(
                                product.rating.toStringAsFixed(1),
                                style: Theme.of(context)
                                    .textTheme
                                    .labelMedium
                                    ?.copyWith(
                                      fontWeight: FontWeight.w600,
                                      color: WingerColors.inkDefault,
                                    ),
                              ),
                              const SizedBox(width: WingerSpacing.s8),
                            ],
                            Flexible(
                              child: Text(
                                _stockLabel(s, product),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: Theme.of(context)
                                    .textTheme
                                    .labelSmall
                                    ?.copyWith(
                                      fontWeight: FontWeight.w700,
                                      color: product.stockStatus ==
                                              StockStatus.outOfStock
                                          ? WingerColors.dangerInk
                                          : product.stockStatus ==
                                                  StockStatus.lowStock
                                              ? WingerColors.attentionInk
                                              : WingerColors.successInk,
                                    ),
                              ),
                            ),
                            if (widget.onCompare != null)
                              IconButton(
                                tooltip: s.t('compare'),
                                constraints: const BoxConstraints.tightFor(
                                  width: 36,
                                  height: 36,
                                ),
                                padding: EdgeInsets.zero,
                                onPressed: widget.onCompare,
                                icon: Icon(
                                  Icons.compare_arrows,
                                  size: 18,
                                  color: widget.compareSelected
                                      ? WingerColors.brandPrimary
                                      : WingerColors.inkMuted,
                                ),
                              ),
                          ],
                        ),
                        const SizedBox(height: WingerSpacing.s4),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Expanded(
                              child: Text.rich(
                                TextSpan(
                                  children: [
                                    TextSpan(
                                      text: session.formatMoney(product.price),
                                      style: Theme.of(context)
                                          .textTheme
                                          .titleMedium
                                          ?.copyWith(
                                            fontWeight: FontWeight.w700,
                                            color: WingerColors.brandPrimary,
                                            height: 1.1,
                                          ),
                                    ),
                                    if (hasPromo)
                                      TextSpan(
                                        text:
                                            ' ${session.formatMoney(product.previousPrice!)}',
                                        style: Theme.of(context)
                                            .textTheme
                                            .labelSmall
                                            ?.copyWith(
                                              decoration:
                                                  TextDecoration.lineThrough,
                                              color: WingerColors.inkMuted,
                                            ),
                                      ),
                                  ],
                                ),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                            if (widget.onAddToCart != null &&
                                !productCardSupportsHover())
                              IconButton(
                                tooltip: s.t('addToCart'),
                                constraints: const BoxConstraints.tightFor(
                                  width: 40,
                                  height: 40,
                                ),
                                padding: EdgeInsets.zero,
                                onPressed:
                                    product.stockStatus == StockStatus.outOfStock
                                        ? null
                                        : () => _emit(widget.onAddToCart!),
                                icon: const Icon(
                                  Icons.add_shopping_cart_outlined,
                                  size: 20,
                                ),
                                color: WingerColors.brandPrimary,
                              ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
