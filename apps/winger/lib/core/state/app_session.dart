import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';

import '../api/api_client.dart';
import '../models/models.dart';
import '../offline/offline_database.dart';
import '../repositories/cart_repository.dart';

class AppSession extends ChangeNotifier {
  AppSession();

  CartRepository? _cartRepository;
  OfflineDatabase? _db;
  ApiClient? _api;

  UserRole? role;
  String displayName = 'Amina Mwangi';
  String email = 'amina.mwangi@example.com';
  String userId = 'user-amina';
  String? supplierId;
  String? accessToken;
  String phone = '';
  String city = 'Nairobi';
  String addressLine = 'Westlands';
  /// express | standard | pickup
  String deliveryMethod = 'standard';
  String settlementCurrency = 'USD';
  String displayCurrency = 'USD';
  double fxRate = 1;
  bool fxFresh = true;
  String? fxError;
  List<String> supportedDisplayCurrencies = const ['USD', 'TZS', 'KES', 'EUR'];
  List<String> supportedPaymentCurrencies = const ['USD', 'TZS'];
  /// demo until STRIPE_SECRET_KEY is sk_test_ or sk_live_.
  String stripeCheckoutMode = 'demo';
  String? stripePublishableKey;
  double cartDeliveryFee = 0;
  double cartTax = 0;
  List<CartShipmentQuote> cartShipments = [];
  LocaleCode localeCode = LocaleCode.en;
  final List<CartItem> _cart = [];
  final List<String> compareIds = [];
  final List<String> wishlistIds = [];
  final List<String> recentlyViewedIds = [];
  CustomerOrder? lastOrder;
  bool apiOnline = false;
  int pendingSyncCount = 0;
  /// Android emulator reaches the host machine through 10.0.2.2, not localhost.
  String apiBaseUrl = !kIsWeb && defaultTargetPlatform == TargetPlatform.android
      ? 'http://10.0.2.2:3000'
      : 'http://localhost:3000';

  List<CartItem> get cart => List.unmodifiable(_cart);
  int get cartCount => _cart.fold(0, (sum, item) => sum + item.quantity);
  /// Product lines only.
  double get cartTotal => _cart.fold(0, (sum, item) => sum + item.lineTotal);
  double get cartGrandTotal =>
      _roundMoney(cartTotal + cartDeliveryFee + cartTax);

  String get paymentCurrency => supportedPaymentCurrencies.contains(displayCurrency)
      ? displayCurrency
      : settlementCurrency;

  bool get showPaymentEstimate =>
      fxFresh && displayCurrency != paymentCurrency;

  String formatMoney(double settlementAmount, {bool settlement = false}) {
    if (settlement || !fxFresh) {
      return '$settlementCurrency ${settlementAmount.toStringAsFixed(2)}';
    }
    final converted = _roundMoney(settlementAmount * fxRate);
    return '$displayCurrency ${converted.toStringAsFixed(2)}';
  }

  void applyCurrencyQuote({
    required String settlement,
    required String display,
    required double rate,
    required bool fresh,
    String? error,
    List<String>? displayOptions,
    List<String>? paymentOptions,
  }) {
    settlementCurrency = settlement;
    displayCurrency = display;
    fxRate = rate <= 0 ? 1 : rate;
    fxFresh = fresh;
    fxError = error;
    if (displayOptions != null && displayOptions.isNotEmpty) {
      supportedDisplayCurrencies = displayOptions;
    }
    if (paymentOptions != null && paymentOptions.isNotEmpty) {
      supportedPaymentCurrencies = paymentOptions;
    }
    final phase = SchedulerBinding.instance.schedulerPhase;
    if (phase == SchedulerPhase.persistentCallbacks ||
        phase == SchedulerPhase.midFrameMicrotasks) {
      SchedulerBinding.instance.addPostFrameCallback((_) => notifyListeners());
      return;
    }
    notifyListeners();
  }
  bool get isSignedIn => role != null;
  bool isWishlisted(String productId) => wishlistIds.contains(productId);

  Map<String, String> get authHeaders => {
        if (accessToken != null) 'Authorization': 'Bearer $accessToken',
        'Content-Type': 'application/json',
      };

  Map<String, List<CartItem>> get cartBySupplier {
    final map = <String, List<CartItem>>{};
    for (final item in _cart) {
      map.putIfAbsent(item.product.supplierName, () => []).add(item);
    }
    return map;
  }

  void attachCartRepository(CartRepository repository) {
    _cartRepository = repository;
  }

  void attachDatabase(OfflineDatabase db) {
    _db = db;
  }

  void attachApi(ApiClient api) {
    _api = api;
  }

  Future<void> load() async {
    if (_cartRepository != null) {
      final items = await _cartRepository!.loadCart();
      _cart
        ..clear()
        ..addAll(items);
    }
    if (_db != null) {
      final wished = await _db!.loadWishlistIds();
      final recent = await _db!.loadRecentlyViewedIds();
      wishlistIds
        ..clear()
        ..addAll(wished);
      recentlyViewedIds
        ..clear()
        ..addAll(recent);
    }
    notifyListeners();
  }

  Future<void> toggleWishlist(String productId) async {
    final next = !wishlistIds.contains(productId);
    if (next) {
      wishlistIds.insert(0, productId);
    } else {
      wishlistIds.remove(productId);
    }
    notifyListeners();
    await _db?.setWishlist(productId, next);
  }

  Future<void> markProductViewed(String productId) async {
    recentlyViewedIds.remove(productId);
    recentlyViewedIds.insert(0, productId);
    if (recentlyViewedIds.length > 12) {
      recentlyViewedIds.removeRange(12, recentlyViewedIds.length);
    }
    notifyListeners();
    await _db?.touchRecentlyViewed(productId);
  }

  Future<void> setLocale(LocaleCode code, {bool persist = true}) async {
    localeCode = code;
    notifyListeners();
    if (!persist || accessToken == null) return;
    try {
      await _api?.updatePreferredLocale(code.code);
    } catch (_) {
      // Keep the language on screen even if the save fails.
    }
  }

  void setDeliveryMethod(String method) {
    final normalized = method.trim().toLowerCase();
    if (normalized != 'express' &&
        normalized != 'standard' &&
        normalized != 'pickup') {
      return;
    }
    if (deliveryMethod == normalized) return;
    deliveryMethod = normalized;
    _recomputeLocalFees();
    notifyListeners();
  }

  String get deliveryMethodLabel {
    switch (deliveryMethod) {
      case 'express':
        return 'Express 1–2 days';
      case 'pickup':
        return 'Pickup';
      default:
        return 'Standard 3–5 days';
    }
  }

  String deliveryEstimateFor(String city) {
    switch (deliveryMethod) {
      case 'express':
        return '1–2 days to $city';
      case 'pickup':
        return 'Ready for pickup in $city';
      default:
        return '3–5 days to $city';
    }
  }

  void _recomputeLocalFees() {
    final suppliers = cartBySupplier.keys.toList();
    final perShipment = deliveryMethod == 'pickup'
        ? 0.0
        : deliveryMethod == 'express'
            ? 9.99
            : 4.99;
    final names = suppliers.isEmpty ? const <String>['Supplier'] : suppliers;
    cartShipments = [
      for (final name in names)
        CartShipmentQuote(
          supplierName: name,
          deliveryMethod: deliveryMethod,
          fee: perShipment,
          estimate: deliveryEstimateFor(city),
        ),
    ];
    cartDeliveryFee = _roundMoney(
      cartShipments.fold<double>(0, (sum, s) => sum + s.fee),
    );
    cartTax = _roundMoney(cartTotal * 0.08);
  }

  void _applyFeeQuote({
    required double deliveryFee,
    required double tax,
    required List<CartShipmentQuote> shipments,
  }) {
    cartDeliveryFee = deliveryFee;
    cartTax = tax;
    cartShipments = List.of(shipments);
  }

  static double _roundMoney(double value) =>
      (value * 100).roundToDouble() / 100;

  void applyAuth({
    required String token,
    required String id,
    required String name,
    required String mail,
    required UserRole selectedRole,
    String? supplier,
    String? phoneNumber,
    String? cityName,
    String? address,
  }) {
    accessToken = token;
    userId = id;
    displayName = name;
    email = mail;
    role = selectedRole;
    supplierId = supplier;
    if (phoneNumber != null) phone = phoneNumber;
    if (cityName != null && cityName.isNotEmpty) city = cityName;
    if (address != null && address.isNotEmpty) addressLine = address;
    notifyListeners();
  }

  void applyProfile({
    required String name,
    required String phoneNumber,
    required String cityName,
    required String address,
  }) {
    displayName = name;
    phone = phoneNumber;
    city = cityName;
    addressLine = address;
    if (_cart.isNotEmpty) _recomputeLocalFees();
    notifyListeners();
  }

  void signOut() {
    role = null;
    accessToken = null;
    supplierId = null;
    phone = '';
    city = 'Nairobi';
    addressLine = 'Westlands';
    compareIds.clear();
    lastOrder = null;
    notifyListeners();
  }

  Future<void> addToCart(Product product, {int quantity = 1}) async {
    final index = _cart.indexWhere((item) => item.product.id == product.id);
    final nextQty = index >= 0 ? _cart[index].quantity + quantity : quantity;
    if (index >= 0) {
      _cart[index] = _cart[index].copyWith(quantity: nextQty);
    } else {
      _cart.add(CartItem(product: product, quantity: nextQty));
    }
    _recomputeLocalFees();
    notifyListeners();
    await _cartRepository?.upsert(product, nextQty);
    if (accessToken != null && _api != null) {
      try {
        await _api!.stampOnboardingActivity('added_to_cart');
      } catch (_) {}
    }
  }

  Future<void> updateQuantity(String productId, int quantity) async {
    if (quantity <= 0) {
      await removeFromCart(productId);
      return;
    }
    final index = _cart.indexWhere((item) => item.product.id == productId);
    if (index >= 0) {
      final product = _cart[index].product;
      _cart[index] = _cart[index].copyWith(quantity: quantity);
      _recomputeLocalFees();
      notifyListeners();
      await _cartRepository?.upsert(product, quantity);
    }
  }

  Future<void> removeFromCart(String productId) async {
    _cart.removeWhere((item) => item.product.id == productId);
    if (_cart.isEmpty) {
      cartDeliveryFee = 0;
      cartTax = 0;
      cartShipments = [];
    } else {
      _recomputeLocalFees();
    }
    notifyListeners();
    await _cartRepository?.remove(productId);
  }

  /// Sync cart lines with trusted server prices/stock. Returns false if issues remain.
  Future<bool> refreshCartFromServer() async {
    if (_cart.isEmpty || _api == null || accessToken == null) {
      if (_cart.isNotEmpty) _recomputeLocalFees();
      notifyListeners();
      return _cart.isNotEmpty &&
          !_cart.any((item) => item.quantity > item.product.stock || item.product.stock <= 0);
    }
    try {
      final result = await _api!.validateCart(
        List.of(_cart),
        deliveryMethod: deliveryMethod,
        city: city,
      );
      final next = <CartItem>[];
      for (final line in result.lines) {
        final product = line.product;
        if (product == null) {
          await _cartRepository?.remove(line.productId);
          continue;
        }
        final qty = line.availableQty <= 0
            ? 0
            : line.requestedQty.clamp(1, line.availableQty);
        if (qty <= 0) {
          await _cartRepository?.remove(product.id);
          continue;
        }
        next.add(CartItem(product: product, quantity: qty));
        await _cartRepository?.upsert(product, qty);
      }
      _cart
        ..clear()
        ..addAll(next);
      if (_cart.isEmpty) {
        cartDeliveryFee = 0;
        cartTax = 0;
        cartShipments = [];
      } else {
        _applyFeeQuote(
          deliveryFee: result.deliveryFee,
          tax: result.tax,
          shipments: result.shipments,
        );
      }
      notifyListeners();
      return result.ok &&
          !_cart.any((item) => item.quantity > item.product.stock);
    } catch (_) {
      _recomputeLocalFees();
      notifyListeners();
      return !_cart.any(
        (item) => item.quantity > item.product.stock || item.product.stock <= 0,
      );
    }
  }

  /// Returns true when the product is now selected for compare.
  bool toggleCompare(String productId) {
    if (compareIds.contains(productId)) {
      compareIds.remove(productId);
      notifyListeners();
      return false;
    }
    if (compareIds.length >= 3) {
      notifyListeners();
      return false;
    }
    compareIds.add(productId);
    notifyListeners();
    return true;
  }

  void clearCompare() {
    if (compareIds.isEmpty) return;
    compareIds.clear();
    notifyListeners();
  }

  void removeFromCompare(String productId) {
    if (!compareIds.remove(productId)) return;
    notifyListeners();
  }

  /// Replaces compare with these product ids (max 3). Used for same-model compare.
  void setCompare(Iterable<String> productIds) {
    compareIds
      ..clear()
      ..addAll(productIds.take(3));
    notifyListeners();
  }

  /// Adds product ids to compare (max 3). Returns how many were newly added.
  int addToCompare(Iterable<String> productIds) {
    var added = 0;
    for (final id in productIds) {
      if (compareIds.contains(id)) continue;
      if (compareIds.length >= 3) break;
      compareIds.add(id);
      added++;
    }
    if (added > 0) notifyListeners();
    return added;
  }

  Future<CustomerOrder> placeOrder({
    String paymentMethod = 'card',
  }) async {
    if (_cart.isEmpty) {
      throw Exception('Cart is empty');
    }

    final cod = paymentMethod == 'pay_on_delivery' ||
        paymentMethod == 'cod' ||
        paymentMethod == 'cash_on_delivery';
    if (cod && deliveryMethod != 'pickup') {
      if (addressLine.trim().isEmpty || city.trim().isEmpty) {
        throw Exception('Address and city are required for pay on delivery');
      }
    }

    if (apiOnline && accessToken != null && _api != null) {
      final order = await _api!.createOrder(
        items: List.of(_cart),
        paymentMethod: paymentMethod,
        addressLine: addressLine,
        city: city,
        deliveryMethod: deliveryMethod,
      );
      lastOrder = order;
      _cart.clear();
      cartDeliveryFee = 0;
      cartTax = 0;
      cartShipments = [];
      notifyListeners();
      await _cartRepository?.clear();
      return order;
    }

    // Offline cannot place a real order — keep the cart so the customer can retry.
    throw Exception(
      cod
          ? 'Pay on delivery needs an online connection. Connect and try again.'
          : 'Checkout needs an online connection. Connect and try again.',
    );
  }

  @Deprecated('Use placeOrder()')
  Future<void> placeDemoOrder() async {
    await placeOrder();
  }

  void setApiOnline(bool value) {
    if (apiOnline == value) return;
    apiOnline = value;
    notifyListeners();
  }

  void setPendingSyncCount(int value) {
    if (pendingSyncCount == value) return;
    pendingSyncCount = value;
    notifyListeners();
  }
}

enum LocaleCode {
  en('en'),
  es('es'),
  sw('sw');

  const LocaleCode(this.code);
  final String code;

  static LocaleCode fromCode(String code) {
    return LocaleCode.values.firstWhere(
      (value) => value.code == code,
      orElse: () => LocaleCode.en,
    );
  }
}
