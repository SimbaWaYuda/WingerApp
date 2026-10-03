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
  });

  final Product product;
  final VoidCallback onTap;
  final VoidCallback? onCompare;
  final bool compareSelected;

  @override
  Widget build(BuildContext context) {
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
            ClipRRect(
              borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
              child: AspectRatio(
                aspectRatio: 1.2,
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
            Expanded(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      product.brand,
                      style: const TextStyle(
                        color: WingerColors.muted,
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      product.name,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontWeight: FontWeight.w700, height: 1.25),
                    ),
                    const Spacer(),
                    Row(
                      children: [
                        const Icon(Icons.star_rounded, size: 16, color: Color(0xFFE0A800)),
                        const SizedBox(width: 4),
                        Text(product.rating.toStringAsFixed(1)),
                        const Spacer(),
                        if (onCompare != null)
                          IconButton(
                            visualDensity: VisualDensity.compact,
                            onPressed: onCompare,
                            icon: Icon(
                              compareSelected ? Icons.compare_arrows : Icons.compare_arrows_outlined,
                              color: compareSelected ? WingerColors.brand : WingerColors.muted,
                            ),
                          ),
                      ],
                    ),
                    Text(
                      '\$${product.price.toStringAsFixed(2)}',
                      style: const TextStyle(
                        fontWeight: FontWeight.w800,
                        fontSize: 16,
                        color: WingerColors.brand,
                      ),
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
}
