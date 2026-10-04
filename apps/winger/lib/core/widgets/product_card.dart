import 'package:flutter/material.dart';

import '../models/models.dart';
import '../theme/winger_colors.dart';

class ProductCard extends StatelessWidget {
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
  final VoidCallback onTap;
  final VoidCallback? onCompare;
  final bool compareSelected;
  final VoidCallback? onWishlist;
  final bool wishlisted;
  final VoidCallback? onAddToCart;

  @override
  Widget build(BuildContext context) {
    final hasPromo =
        product.previousPrice != null && product.previousPrice! > product.price;

    return InkWell(
      onTap: onTap,
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
                  borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
                  child: AspectRatio(
                    aspectRatio: 1.35,
                    child: Image.network(
                      product.imageUrl,
                      fit: BoxFit.cover,
                      errorBuilder: (context, error, stackTrace) => Container(
                        color: WingerColors.brandMuted,
                        alignment: Alignment.center,
                        child: const Icon(Icons.image_outlined, color: WingerColors.brand),
                      ),
                    ),
                  ),
                ),
                if (onWishlist != null)
                  Positioned(
                    top: 4,
                    right: 4,
                    child: Material(
                      color: Colors.white.withValues(alpha: 0.92),
                      shape: const CircleBorder(),
                      child: IconButton(
                        constraints: const BoxConstraints.tightFor(width: 32, height: 32),
                        padding: EdgeInsets.zero,
                        onPressed: onWishlist,
                        icon: Icon(
                          wishlisted ? Icons.favorite : Icons.favorite_border,
                          color: wishlisted ? WingerColors.dangerInk : WingerColors.muted,
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
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
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
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
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
                            style: const TextStyle(fontSize: 10, color: WingerColors.muted),
                          ),
                        ),
                        if (product.supplierVerified) ...[
                          const SizedBox(width: 2),
                          const Icon(Icons.verified, size: 12, color: WingerColors.brand),
                        ],
                      ],
                    ),
                    const Spacer(),
                    Row(
                      children: [
                        const Icon(Icons.star_rounded, size: 14, color: Color(0xFFE0A800)),
                        const SizedBox(width: 2),
                        Text(
                          product.rating.toStringAsFixed(1),
                          style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
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
                        if (onCompare != null)
                          SizedBox(
                            width: 28,
                            height: 28,
                            child: IconButton(
                              padding: EdgeInsets.zero,
                              onPressed: onCompare,
                              icon: Icon(
                                compareSelected
                                    ? Icons.compare_arrows
                                    : Icons.compare_arrows_outlined,
                                size: 18,
                                color: compareSelected ? WingerColors.brand : WingerColors.muted,
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
                                  text: '\$${product.price.toStringAsFixed(2)}',
                                  style: const TextStyle(
                                    fontWeight: FontWeight.w800,
                                    fontSize: 14,
                                    color: WingerColors.brand,
                                  ),
                                ),
                                if (hasPromo)
                                  TextSpan(
                                    text: ' \$${product.previousPrice!.toStringAsFixed(2)}',
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
                        if (onAddToCart != null)
                          SizedBox(
                            width: 30,
                            height: 30,
                            child: IconButton(
                              padding: EdgeInsets.zero,
                              onPressed: product.stockStatus == StockStatus.outOfStock
                                  ? null
                                  : onAddToCart,
                              icon: const Icon(Icons.add_shopping_cart_outlined, size: 18),
                              color: WingerColors.brand,
                            ),
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
