import 'package:flutter/widgets.dart';
import 'package:flutter_svg/flutter_svg.dart';

/// The Winger mark from `assets/branding/winger-logo.svg`.
///
/// [size] is the width. The height follows the master 161:148 ratio.
class WingerLogo extends StatelessWidget {
  const WingerLogo({super.key, this.size = 120});

  final double size;

  static const double masterWidth = 161;
  static const double masterHeight = 148;

  @override
  Widget build(BuildContext context) {
    return SvgPicture.asset(
      'assets/branding/winger-logo.svg',
      width: size,
      height: size * masterHeight / masterWidth,
      fit: BoxFit.contain,
    );
  }
}
