import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../data/mock_catalog.dart';
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
  LocaleCode localeCode = LocaleCode.en;
  final List<CartItem> _cart = [];
  final List<String> compareIds = [];
  final List<String> wishlistIds = [];
  final List<String> recentlyViewedIds = [];
  CustomerOrder? lastOrder;
  bool apiOnline = false;
  int pendingSyncCount = 0;
  String apiBaseUrl = 'http://localhost:3000';

  List<CartItem> get cart => List.unmodifiable(_cart);
  int get cartCount => _cart.fold(0, (sum, item) => sum + item.quantity);
  double get cartTotal => _cart.fold(0, (sum, item) => sum + item.lineTotal);
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

  Future<void> setLocale(LocaleCode code) async {
    localeCode = code;
    notifyListeners();
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
    notifyListeners();
  }

  /// Offline/demo fallback when API auth is unavailable.
  void signInLocal(UserRole selected, {String? name, String? mail}) {
    role = selected;
    accessToken = null;
    if (mail != null && mail.isNotEmpty) email = mail;
    switch (selected) {
      case UserRole.customer:
        displayName = name?.isNotEmpty == true ? name! : 'Amina Mwangi';
        userId = 'user-amina';
        supplierId = null;
      case UserRole.supplier:
        displayName = name?.isNotEmpty == true ? name! : 'John Doe';
        userId = 'user-supplier-john';
        supplierId = 's-kijani';
      case UserRole.admin:
        displayName = name?.isNotEmpty == true ? name! : 'Winger Admin';
        userId = 'user-admin';
        supplierId = null;
    }
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
      notifyListeners();
      await _cartRepository?.upsert(product, quantity);
    }
  }

  Future<void> removeFromCart(String productId) async {
    _cart.removeWhere((item) => item.product.id == productId);
    notifyListeners();
    await _cartRepository?.remove(productId);
  }

  /// Sync cart lines with trusted server prices/stock. Returns false if issues remain.
  Future<bool> refreshCartFromServer() async {
    if (_cart.isEmpty || _api == null || accessToken == null) {
      return _cart.isNotEmpty &&
          !_cart.any((item) => item.quantity > item.product.stock || item.product.stock <= 0);
    }
    try {
      final result = await _api!.validateCart(List.of(_cart));
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
      notifyListeners();
      return result.ok &&
          !_cart.any((item) => item.quantity > item.product.stock);
    } catch (_) {
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

    if (apiOnline && accessToken != null && _api != null) {
      final order = await _api!.createOrder(
        items: List.of(_cart),
        paymentMethod: paymentMethod,
        addressLine: addressLine,
        city: city,
      );
      lastOrder = order;
      _cart.clear();
      notifyListeners();
      await _cartRepository?.clear();
      return order;
    }

    // Offline / unsigned fallback — keep a local demo order.
    lastOrder = MockCatalog.sampleOrder;
    _cart.clear();
    notifyListeners();
    await _cartRepository?.clear();
    return lastOrder!;
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
