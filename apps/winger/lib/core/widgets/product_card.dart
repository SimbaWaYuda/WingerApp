import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../models/models.dart';
import '../state/app_session.dart';
import '../theme/winger_colors.dart';
import 'product_photo.dart';

/// How many catalogue cards fit across the space the grid actually has.
int productGridColumns(double maxWidth) {
  if (maxWidth >= 1280) return 5;
  if (maxWidth >= 980) return 4;
  if (maxWidth >= 680) return 3;
  return 2;
}

/// Card height for a given column width: photo plus the text, swatches, and size row.
double productCardHeight(double cardWidth) {
  final imageHeight = cardWidth / 1.35;
  // Brand, name, supplier, colour dots, size chips, rating, and price.
  return imageHeight + 220;
}

SliverGridDelegate productGridDelegate(double maxWidth) {
  final columns = productGridColumns(maxWidth);
  final cardWidth = (maxWidth - 12 * (columns - 1)) / columns;
  return SliverGridDelegateWithFixedCrossAxisCount(
    crossAxisCount: columns,
    mainAxisSpacing: 12,
    crossAxisSpacing: 12,
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

  String? _hexFor(String color) {
    for (final row in widget.product.enabledVariants) {
      if (row.color.trim().toLowerCase() != color.trim().toLowerCase()) {
        continue;
      }
      final hex = (row.colorHex ?? '').trim();
      if (hex.isNotEmpty) return hex;
    }
    return null;
  }

  String _photoUrl() {
    final urls = widget.product.galleryUrlsForColor(_color);
    if (urls.isNotEmpty) return urls.first;
    return widget.product.imageUrl;
  }

  void _chooseColor(String color) {
    setState(() {
      _color = color;
      final sizes = widget.product.selectableSizes;
      final current = _size;
      final stillFits =
          current != null &&
          (!widget.product.hasVariants ||
              widget.product.variantFor(color: color, size: current) != null);
      _size = stillFits ? current : _firstSizeFor(color, sizes);
    });
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

  @override
  Widget build(BuildContext context) {
    final product = widget.product;
    final hasPromo =
        product.previousPrice != null && product.previousPrice! > product.price;
    final colors = product.selectableColors;
    final sizes = product.selectableSizes;

    return InkWell(
      onTap: () => _emit(widget.onTap),
      borderRadius: BorderRadius.circular(16),
      child: Ink(
        decoration: BoxDecoration(
          color: WingerColors.white,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: WingerColors.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Stack(
              children: [
                ClipRRect(
                  borderRadius: const BorderRadius.vertical(
                    top: Radius.circular(16),
                  ),
                  child: AspectRatio(
                    aspectRatio: 1.35,
                    child: ProductPhoto(url: _photoUrl()),
                  ),
                ),
                if (widget.onWishlist != null)
                  Positioned(
                    top: 4,
                    right: 4,
                    child: Material(
                      color: Colors.white.withValues(alpha: 0.92),
                      shape: const CircleBorder(),
                      child: IconButton(
                        constraints: const BoxConstraints.tightFor(
                          width: 32,
                          height: 32,
                        ),
                        padding: EdgeInsets.zero,
                        onPressed: widget.onWishlist,
                        icon: Icon(
                          widget.wishlisted
                              ? Icons.favorite
                              : Icons.favorite_border,
                          color: widget.wishlisted
                              ? WingerColors.dangerInk
                              : WingerColors.muted,
                          size: 18,
                        ),
                      ),
                    ),
                  ),
                if (hasPromo)
                  Positioned(
                    top: 8,
                    left: 8,
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 3,
                      ),
                      decoration: BoxDecoration(
                        color: WingerColors.attention,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        'Sale',
                        style: TextStyle(
                          color: WingerColors.attentionInk,
                          fontWeight: FontWeight.w800,
                          fontSize: 11,
                        ),
                      ),
                    ),
                  ),
              ],
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (colors.isNotEmpty) ...[
                    SizedBox(
                      height: 28,
                      child: ListView.separated(
                        scrollDirection: Axis.horizontal,
                        itemCount: colors.length,
                        separatorBuilder: (_, __) => const SizedBox(width: 6),
                        itemBuilder: (context, index) {
                          final color = colors[index];
                          return _ColorDot(
                            color: catalogSwatchColor(
                              color,
                              hex: _hexFor(color),
                            ),
                            selected:
                                color.trim().toLowerCase() ==
                                (_color ?? '').trim().toLowerCase(),
                            label: color,
                            onTap: () => _chooseColor(color),
                          );
                        },
                      ),
                    ),
                    const SizedBox(height: 6),
                  ],
                  Text(
                    product.brand,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: WingerColors.muted,
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    product.name,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontWeight: FontWeight.w700,
                      height: 1.15,
                      fontSize: 13,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          product.supplierName,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 10,
                            color: WingerColors.muted,
                          ),
                        ),
                      ),
                      if (product.supplierVerified) ...[
                        const SizedBox(width: 2),
                        const Icon(
                          Icons.verified,
                          size: 12,
                          color: WingerColors.brand,
                        ),
                      ],
                    ],
                  ),
                  if (sizes.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    SizedBox(
                      height: 26,
                      child: ListView.separated(
                        scrollDirection: Axis.horizontal,
                        itemCount: sizes.length,
                        separatorBuilder: (_, __) => const SizedBox(width: 6),
                        itemBuilder: (context, index) {
                          final size = sizes[index];
                          final selected =
                              size.trim().toLowerCase() ==
                              (_size ?? '').trim().toLowerCase();
                          return _SizeChip(
                            label: size,
                            selected: selected,
                            onTap: () => setState(() => _size = size),
                          );
                        },
                      ),
                    ),
                  ],
                  const SizedBox(height: 6),
                  Row(
                    children: [
                      const Icon(
                        Icons.star_rounded,
                        size: 14,
                        color: Color(0xFFE0A800),
                      ),
                      const SizedBox(width: 2),
                      Text(
                        product.rating.toStringAsFixed(1),
                        style: const TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(width: 6),
                      Flexible(
                        child: Text(
                          _stockLabel(product),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w700,
                            color: product.stockStatus == StockStatus.outOfStock
                                ? WingerColors.dangerInk
                                : WingerColors.successInk,
                          ),
                        ),
                      ),
                      if (widget.onCompare != null)
                        SizedBox(
                          width: 28,
                          height: 28,
                          child: IconButton(
                            padding: EdgeInsets.zero,
                            onPressed: widget.onCompare,
                            icon: Icon(
                              Icons.compare_arrows,
                              size: 18,
                              color: widget.compareSelected
                                  ? WingerColors.brand
                                  : WingerColors.muted,
                            ),
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Row(
                    children: [
                      Flexible(
                        child: Text.rich(
                          TextSpan(
                            children: [
                              TextSpan(
                                text: context.watch<AppSession>().formatMoney(
                                  product.price,
                                ),
                                style: const TextStyle(
                                  fontWeight: FontWeight.w800,
                                  fontSize: 14,
                                  color: WingerColors.brand,
                                ),
                              ),
                              if (hasPromo)
                                TextSpan(
                                  text:
                                      ' ${context.read<AppSession>().formatMoney(product.previousPrice!)}',
                                  style: const TextStyle(
                                    decoration: TextDecoration.lineThrough,
                                    color: WingerColors.muted,
                                    fontSize: 11,
                                  ),
                                ),
                            ],
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      if (widget.onAddToCart != null)
                        SizedBox(
                          width: 30,
                          height: 30,
                          child: IconButton(
                            padding: EdgeInsets.zero,
                            onPressed:
                                product.stockStatus == StockStatus.outOfStock
                                ? null
                                : () => _emit(widget.onAddToCart!),
                            icon: const Icon(
                              Icons.add_shopping_cart_outlined,
                              size: 18,
                            ),
                            color: WingerColors.brand,
                          ),
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _stockLabel(Product product) {
    switch (product.stockStatus) {
      case StockStatus.outOfStock:
        return 'Out';
      case StockStatus.lowStock:
        return 'Low';
      case StockStatus.inStock:
        return 'In stock';
    }
  }
}

class _ColorDot extends StatelessWidget {
  const _ColorDot({
    required this.color,
    required this.selected,
    required this.label,
    required this.onTap,
  });

  final Color color;
  final bool selected;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: label,
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          onTap: onTap,
          customBorder: const CircleBorder(),
          child: Container(
            width: 26,
            height: 26,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(
                color: selected ? WingerColors.ink : Colors.transparent,
                width: 1.6,
              ),
            ),
            child: Container(
              width: 16,
              height: 16,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: color,
                border: Border.all(color: const Color(0xFFD0D0D0)),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _SizeChip extends StatelessWidget {
  const _SizeChip({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? WingerColors.brand : WingerColors.white,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(8),
        side: BorderSide(
          color: selected ? WingerColors.brand : WingerColors.border,
        ),
      ),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          child: Text(
            label,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w700,
              color: selected ? Colors.white : WingerColors.ink,
            ),
          ),
        ),
      ),
    );
  }
}
