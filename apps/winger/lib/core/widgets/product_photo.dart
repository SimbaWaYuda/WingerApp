import 'package:flutter/material.dart';

import '../theme/winger_colors.dart';

bool isProductImageMissing(String? url) {
  return (url ?? '').trim().isEmpty;
}

/// Neutral “no photo” tile — never a random stock product image.
class ProductPhoto extends StatelessWidget {
  const ProductPhoto({
    super.key,
    required this.url,
    this.fit = BoxFit.cover,
    this.iconSize = 36,
    this.filterQuality = FilterQuality.high,
  });

  final String url;
  final BoxFit fit;
  final double iconSize;
  final FilterQuality filterQuality;

  @override
  Widget build(BuildContext context) {
    if (isProductImageMissing(url)) {
      return _MissingProductPhoto(iconSize: iconSize);
    }
    return Image.network(
      url,
      fit: fit,
      filterQuality: filterQuality,
      isAntiAlias: true,
      gaplessPlayback: true,
      errorBuilder: (_, __, ___) => _MissingProductPhoto(iconSize: iconSize),
    );
  }
}

class _MissingProductPhoto extends StatelessWidget {
  const _MissingProductPhoto({required this.iconSize});

  final double iconSize;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: WingerColors.brandMuted,
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.image_outlined, color: WingerColors.muted, size: iconSize),
            const SizedBox(height: 4),
            Text(
              'No photo',
              style: TextStyle(
                color: WingerColors.muted,
                fontSize: iconSize > 28 ? 12 : 10,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
