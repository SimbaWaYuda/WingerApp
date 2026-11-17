import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:winger/core/l10n/winger_strings.dart';
import 'package:winger/core/models/models.dart';
import 'package:winger/core/state/app_session.dart';
import 'package:winger/core/theme/winger_theme.dart';
import 'package:winger/core/theme/winger_tokens.dart';
import 'package:winger/core/widgets/product_card.dart';
import 'package:winger/core/widgets/product_photo.dart';

Product _sampleProduct({
  String imageUrl = '',
  double rating = 4.5,
  StockStatus stock = StockStatus.inStock,
}) {
  return Product(
    id: 'p1',
    name: 'Savanna Lounge Chair',
    brand: 'Kijani',
    category: 'Furniture',
    model: 'SLC-1',
    supplierId: 's1',
    supplierName: 'Kijani Goods',
    price: 120,
    rating: rating,
    imageUrl: imageUrl,
    stockStatus: stock,
    description: 'A calm chair',
  );
}

Widget _wrap(Widget child, {Locale locale = const Locale('en')}) {
  final session = AppSession();
  return MaterialApp(
    locale: locale,
    theme: WingerTheme.light(),
    supportedLocales: WingerStrings.supported,
    localizationsDelegates: const [
      WingerStringsDelegate(),
      GlobalMaterialLocalizations.delegate,
      GlobalWidgetsLocalizations.delegate,
      GlobalCupertinoLocalizations.delegate,
    ],
    home: ChangeNotifierProvider.value(
      value: session,
      child: Scaffold(body: Center(child: child)),
    ),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('product image ratio', () {
    test('layout token is 4:5', () {
      expect(WingerLayout.productImageAspectRatio, closeTo(0.8, 1e-9));
    });

    test('grid height uses 4:5 photo block', () {
      const width = 200.0;
      final height = productCardHeight(width);
      final imageHeight = width / WingerLayout.productImageAspectRatio;
      expect(height, greaterThan(imageHeight));
      expect(productGridColumns(400), 2);
      expect(productGridColumns(700), 3);
      expect(productGridColumns(1000), 4);
      expect(productGridColumns(1300), 5);
    });
  });

  group('ProductPhoto', () {
    testWidgets('missing image shows localised empty state', (tester) async {
      await tester.pumpWidget(
        _wrap(const SizedBox(
          width: 160,
          height: 200,
          child: ProductPhoto(url: ''),
        )),
      );
      await tester.pump();
      expect(find.text('No photo'), findsOneWidget);
    });

    testWidgets('missing image localises to Spanish', (tester) async {
      await tester.pumpWidget(
        _wrap(
          const SizedBox(
            width: 160,
            height: 200,
            child: ProductPhoto(url: ''),
          ),
          locale: const Locale('es'),
        ),
      );
      await tester.pump();
      expect(find.text('Sin foto'), findsOneWidget);
    });
  });

  group('ProductCard', () {
    testWidgets('renders title price stock and wishlist', (tester) async {
      var wishlisted = false;
      var added = false;
      await tester.pumpWidget(
        _wrap(
          SizedBox(
            width: 180,
            height: productCardHeight(180),
            child: ProductCard(
              product: _sampleProduct(rating: 4.2),
              wishlisted: wishlisted,
              onWishlist: () => wishlisted = true,
              onAddToCart: ({variantId, color, size}) => added = true,
              onTap: ({variantId, color, size}) {},
            ),
          ),
        ),
      );
      await tester.pump();
      expect(find.text('Savanna Lounge Chair'), findsOneWidget);
      expect(find.textContaining('4.2'), findsOneWidget);
      expect(find.text('In stock'), findsOneWidget);
      await tester.tap(find.byTooltip('Wishlist'));
      await tester.pump();
      expect(wishlisted, isTrue);
      // Mobile/test VM: accessible add button (non-hover platforms).
      if (!productCardSupportsHover()) {
        await tester.tap(find.byTooltip('Add to cart'));
        await tester.pump();
        expect(added, isTrue);
      }
    });

    testWidgets('out of stock uses localised label without inventing data',
        (tester) async {
      await tester.pumpWidget(
        _wrap(
          SizedBox(
            width: 180,
            height: productCardHeight(180),
            child: ProductCard(
              product: _sampleProduct(
                rating: 0,
                stock: StockStatus.outOfStock,
              ),
              onTap: ({variantId, color, size}) {},
            ),
          ),
        ),
      );
      await tester.pump();
      expect(find.text('Out of stock'), findsOneWidget);
      expect(find.textContaining('★'), findsNothing);
    });
  });
}
