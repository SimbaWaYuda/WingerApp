import 'package:flutter/material.dart';

import '../l10n/winger_strings.dart';
import '../theme/winger_colors.dart';
import '../theme/winger_tokens.dart';

bool isProductImageMissing(String? url) {
  return (url ?? '').trim().isEmpty;
}

/// Product photography tile — calm missing state, no fake inventory images.
class ProductPhoto extends StatelessWidget {
  const ProductPhoto({
    super.key,
    required this.url,
    this.fit = BoxFit.cover,
    this.iconSize = 36,
    this.filterQuality = FilterQuality.high,
    this.semanticLabel,
  });

  final String url;
  final BoxFit fit;
  final double iconSize;
  final FilterQuality filterQuality;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final missingLabel = _missingLabel(context);
    if (isProductImageMissing(url)) {
      return _MissingProductPhoto(iconSize: iconSize, label: missingLabel);
    }
    return Semantics(
      image: true,
      label: semanticLabel ?? missingLabel,
      child: Image.network(
        url,
        fit: fit,
        width: double.infinity,
        height: double.infinity,
        filterQuality: filterQuality,
        isAntiAlias: true,
        gaplessPlayback: true,
        frameBuilder: (context, child, frame, wasSynchronouslyLoaded) {
          if (wasSynchronouslyLoaded || frame != null) return child;
          return ColoredBox(
            color: WingerColors.brandMuted,
            child: Center(
              child: SizedBox(
                width: iconSize * 0.6,
                height: iconSize * 0.6,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: WingerColors.brandSoft,
                ),
              ),
            ),
          );
        },
        errorBuilder: (context, error, stackTrace) =>
            _MissingProductPhoto(iconSize: iconSize, label: missingLabel),
      ),
    );
  }

  String _missingLabel(BuildContext context) {
    final strings = Localizations.of<WingerStrings>(context, WingerStrings);
    return strings?.t('noPhoto') ?? 'No photo';
  }
}

/// 4:5 product image frame with shared radius (listing cards / thumbs).
class ProductImageFrame extends StatelessWidget {
  const ProductImageFrame({
    super.key,
    required this.url,
    this.borderRadius,
    this.fit = BoxFit.cover,
    this.iconSize = 36,
    this.semanticLabel,
  });

  final String url;
  final BorderRadius? borderRadius;
  final BoxFit fit;
  final double iconSize;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final radius = borderRadius ?? WingerRadius.imageAll;
    return AspectRatio(
      aspectRatio: WingerLayout.productImageAspectRatio,
      child: ClipRRect(
        borderRadius: radius,
        child: ProductPhoto(
          url: url,
          fit: fit,
          iconSize: iconSize,
          semanticLabel: semanticLabel,
        ),
      ),
    );
  }
}

class _MissingProductPhoto extends StatelessWidget {
  const _MissingProductPhoto({
    required this.iconSize,
    required this.label,
  });

  final double iconSize;
  final String label;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: WingerColors.brandMuted,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final showLabel = constraints.maxHeight >= 72 && constraints.maxWidth >= 64;
          return Center(
            child: FittedBox(
              fit: BoxFit.scaleDown,
              child: Padding(
                padding: const EdgeInsets.all(4),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      Icons.image_outlined,
                      color: WingerColors.inkMuted,
                      size: iconSize,
                    ),
                    if (showLabel) ...[
                      const SizedBox(height: WingerSpacing.s4),
                      Text(
                        label,
                        style: TextStyle(
                          color: WingerColors.inkMuted,
                          fontSize: iconSize > 28 ? 12 : 10,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}
