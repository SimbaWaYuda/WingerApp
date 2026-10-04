import 'dart:convert';

import 'package:http/http.dart' as http;

import '../../features/onboarding/onboarding_models.dart';
import '../models/models.dart';
import '../state/app_session.dart';

class ApiClient {
  ApiClient(this.session);

  final AppSession session;

  Uri _uri(String path) => Uri.parse('${session.apiBaseUrl}$path');

  Future<bool> healthCheck() async {
    try {
      final response =
          await http.get(_uri('/health')).timeout(const Duration(seconds: 2));
      final ok = response.statusCode == 200;
      session.setApiOnline(ok);
      return ok;
    } catch (_) {
      session.setApiOnline(false);
      return false;
    }
  }

  Future<void> register({
    required String email,
    required String password,
    required String name,
    required UserRole role,
    String? businessName,
    String? preferredSupplierSlug,
  }) async {
    final response = await http
        .post(
          _uri('/auth/register'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({
            'email': email,
            'password': password,
            'name': name,
            'role': switch (role) {
              UserRole.customer => 'CUSTOMER',
              UserRole.supplier => 'SUPPLIER',
              UserRole.admin => 'ADMIN',
            },
            if (businessName != null && businessName.isNotEmpty)
              'businessName': businessName,
            if (preferredSupplierSlug != null && preferredSupplierSlug.isNotEmpty)
              'preferredSupplierSlug': preferredSupplierSlug,
          }),
        )
        .timeout(const Duration(seconds: 8));

    if (response.statusCode != 200 && response.statusCode != 201) {
      final body = _tryJson(response.body);
      throw Exception(
        body?['message']?.toString() ?? 'Signup failed (${response.statusCode})',
      );
    }

    final data = jsonDecode(response.body) as Map<String, dynamic>;
    final user = data['user'] as Map<String, dynamic>;
    session.applyAuth(
      token: data['accessToken'] as String,
      id: user['id'] as String,
      name: user['name'] as String,
      mail: user['email'] as String,
      selectedRole: role,
      supplier: user['supplierId'] as String?,
    );
    session.setApiOnline(true);
    await refreshProfile();
  }

  Future<void> login({
    required String email,
    required String password,
    required UserRole role,
  }) async {
    final response = await http
        .post(
          _uri('/auth/login'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({
            'email': email,
            'password': password,
            'role': switch (role) {
              UserRole.customer => 'CUSTOMER',
              UserRole.supplier => 'SUPPLIER',
              UserRole.admin => 'ADMIN',
            },
          }),
        )
        .timeout(const Duration(seconds: 5));

    if (response.statusCode != 200 && response.statusCode != 201) {
      final body = _tryJson(response.body);
      throw Exception(body?['message']?.toString() ?? 'Login failed (${response.statusCode})');
    }

    final data = jsonDecode(response.body) as Map<String, dynamic>;
    final user = data['user'] as Map<String, dynamic>;
    session.applyAuth(
      token: data['accessToken'] as String,
      id: user['id'] as String,
      name: user['name'] as String,
      mail: user['email'] as String,
      selectedRole: role,
      supplier: user['supplierId'] as String?,
    );
    session.setApiOnline(true);
    await refreshProfile();
  }

  Future<void> refreshProfile() async {
    if (session.accessToken == null) return;
    try {
      final response = await http
          .get(_uri('/auth/me'), headers: session.authHeaders)
          .timeout(const Duration(seconds: 5));
      if (response.statusCode != 200) return;
      final user = jsonDecode(response.body) as Map<String, dynamic>;
      session.applyProfile(
        name: user['name'] as String? ?? session.displayName,
        phoneNumber: user['phone'] as String? ?? '',
        cityName: user['city'] as String? ?? 'Nairobi',
        address: user['addressLine'] as String? ?? 'Westlands',
      );
      final locale = user['preferredLocale'] as String?;
      if (locale != null) {
        await session.setLocale(LocaleCode.fromCode(locale));
      }
    } catch (_) {}
  }

  Future<void> updateProfile({
    required String name,
    required String phone,
    required String city,
    required String addressLine,
  }) async {
    final response = await http
        .patch(
          _uri('/auth/profile'),
          headers: session.authHeaders,
          body: jsonEncode({
            'name': name,
            'phone': phone,
            'city': city,
            'addressLine': addressLine,
          }),
        )
        .timeout(const Duration(seconds: 5));
    if (response.statusCode != 200) {
      final body = _tryJson(response.body);
      throw Exception(body?['message']?.toString() ?? 'Profile save failed');
    }
    final user = jsonDecode(response.body) as Map<String, dynamic>;
    session.applyProfile(
      name: user['name'] as String? ?? name,
      phoneNumber: user['phone'] as String? ?? phone,
      cityName: user['city'] as String? ?? city,
      address: user['addressLine'] as String? ?? addressLine,
    );
  }

  Future<List<Product>> fetchProducts({String query = ''}) async {
    final uri = query.isEmpty
        ? _uri('/products')
        : _uri('/products').replace(queryParameters: {'q': query});
    final response = await http
        .get(uri, headers: session.authHeaders)
        .timeout(const Duration(seconds: 3));
    if (response.statusCode != 200) {
      throw Exception('Products HTTP ${response.statusCode}');
    }
    session.setApiOnline(true);
    final decoded = jsonDecode(response.body);
    if (decoded is List) {
      return decoded
          .map((raw) => _productFromJson(raw as Map<String, dynamic>))
          .toList();
    }
    if (decoded is Map<String, dynamic>) {
      final items = decoded['items'] as List<dynamic>? ?? const [];
      return items
          .map((raw) => _productFromJson(raw as Map<String, dynamic>))
          .toList();
    }
    return const [];
  }

  Future<List<CatalogCategory>> fetchCategories() async {
    final response = await http
        .get(_uri('/products/categories'), headers: session.authHeaders)
        .timeout(const Duration(seconds: 3));
    if (response.statusCode != 200) {
      throw Exception('Categories HTTP ${response.statusCode}');
    }
    session.setApiOnline(true);
    final data = jsonDecode(response.body) as List<dynamic>;
    return data.map((raw) {
      final row = raw as Map<String, dynamic>;
      return CatalogCategory(
        name: row['name'] as String? ?? 'General',
        productCount: row['productCount'] as int? ?? 0,
      );
    }).toList();
  }

  Future<ProductPage> browseProducts({
    String query = '',
    String? category,
    String? brand,
    String? supplierId,
    double? minPrice,
    double? maxPrice,
    bool inStock = false,
    String sort = 'relevance',
    int page = 1,
    int pageSize = 24,
  }) async {
    final params = <String, String>{
      'page': '$page',
      'pageSize': '$pageSize',
      'sort': sort,
      if (query.trim().isNotEmpty) 'q': query.trim(),
      if (category != null && category.isNotEmpty) 'category': category,
      if (brand != null && brand.isNotEmpty) 'brand': brand,
      if (supplierId != null && supplierId.isNotEmpty) 'supplierId': supplierId,
      if (minPrice != null) 'minPrice': minPrice.toString(),
      if (maxPrice != null) 'maxPrice': maxPrice.toString(),
      if (inStock) 'inStock': 'true',
    };
    final response = await http
        .get(
          _uri('/products').replace(queryParameters: params),
          headers: session.authHeaders,
        )
        .timeout(const Duration(seconds: 5));
    if (response.statusCode != 200) {
      throw Exception('Browse HTTP ${response.statusCode}');
    }
    session.setApiOnline(true);
    final decoded = jsonDecode(response.body);
    if (decoded is List) {
      final items = decoded
          .map((raw) => _productFromJson(raw as Map<String, dynamic>))
          .toList();
      return ProductPage(
        items: items,
        total: items.length,
        page: 1,
        pageSize: items.length,
        totalPages: 1,
      );
    }
    final map = decoded as Map<String, dynamic>;
    final items = (map['items'] as List<dynamic>? ?? const [])
        .map((raw) => _productFromJson(raw as Map<String, dynamic>))
        .toList();
    return ProductPage(
      items: items,
      total: map['total'] as int? ?? items.length,
      page: map['page'] as int? ?? page,
      pageSize: map['pageSize'] as int? ?? pageSize,
      totalPages: map['totalPages'] as int? ?? 1,
    );
  }

  Future<Product> fetchProduct(String id) async {
    final response = await http
        .get(_uri('/products/$id'), headers: session.authHeaders)
        .timeout(const Duration(seconds: 3));
    if (response.statusCode != 200) {
      throw Exception('Product HTTP ${response.statusCode}');
    }
    session.setApiOnline(true);
    return _productFromJson(jsonDecode(response.body) as Map<String, dynamic>);
  }

  Future<CustomerOrder> createOrder({
    required List<CartItem> items,
    String paymentMethod = 'card',
    String addressLine = 'Westlands',
    String city = 'Nairobi',
  }) async {
    final response = await http
        .post(
          _uri('/orders'),
          headers: session.authHeaders,
          body: jsonEncode({
            'paymentMethod': paymentMethod,
            'addressLine': addressLine,
            'city': city,
            'items': [
              for (final item in items)
                {
                  'productId': item.product.id,
                  'quantity': item.quantity,
                },
            ],
          }),
        )
        .timeout(const Duration(seconds: 15));

    if (response.statusCode != 200 && response.statusCode != 201) {
      final body = _tryJson(response.body);
      throw Exception(
        body?['message']?.toString() ?? 'Order failed (${response.statusCode})',
      );
    }

    session.setApiOnline(true);
    return customerOrderFromApi(jsonDecode(response.body) as Map<String, dynamic>);
  }

  Future<List<CustomerOrder>> fetchOrders() async {
    final response = await http
        .get(_uri('/orders'), headers: session.authHeaders)
        .timeout(const Duration(seconds: 5));
    if (response.statusCode != 200) {
      throw Exception('Orders HTTP ${response.statusCode}');
    }
    session.setApiOnline(true);
    final data = jsonDecode(response.body) as List<dynamic>;
    return data
        .map((raw) => customerOrderFromApi(raw as Map<String, dynamic>))
        .toList();
  }

  Future<CustomerOrder> updateOrderItemStatus({
    required String orderId,
    required String itemId,
    OrderStatus? status,
    String? trackingCode,
    String? pickupCode,
    bool collectPayment = false,
  }) async {
    if (status == null && !collectPayment) {
      throw Exception('status or collectPayment is required');
    }
    final response = await http
        .patch(
          _uri('/orders/$orderId/items/$itemId'),
          headers: session.authHeaders,
          body: jsonEncode({
            if (status != null) 'status': orderStatusToApi(status),
            if (trackingCode != null) 'trackingCode': trackingCode,
            if (pickupCode != null) 'pickupCode': pickupCode,
            if (collectPayment) 'collectPayment': true,
          }),
        )
        .timeout(const Duration(seconds: 5));
    if (response.statusCode != 200) {
      final body = _tryJson(response.body);
      throw Exception(
        body?['message']?.toString() ??
            'Update item failed (${response.statusCode})',
      );
    }
    session.setApiOnline(true);
    return customerOrderFromApi(jsonDecode(response.body) as Map<String, dynamic>);
  }

  Future<OnboardingProgress> fetchOnboarding() async {
    final response = await http
        .get(_uri('/onboarding'), headers: session.authHeaders)
        .timeout(const Duration(seconds: 5));
    if (response.statusCode != 200) {
      throw Exception('Onboarding HTTP ${response.statusCode}');
    }
    return OnboardingProgress.fromJson(
      jsonDecode(response.body) as Map<String, dynamic>,
    );
  }

  Future<OnboardingProgress> startOnboarding() async {
    final response = await http
        .post(_uri('/onboarding/start'), headers: session.authHeaders)
        .timeout(const Duration(seconds: 5));
    if (response.statusCode != 200 && response.statusCode != 201) {
      throw Exception('Start onboarding failed');
    }
    return OnboardingProgress.fromJson(
      jsonDecode(response.body) as Map<String, dynamic>,
    );
  }

  Future<OnboardingProgress> dismissOnboarding() async {
    final response = await http
        .post(_uri('/onboarding/dismiss'), headers: session.authHeaders)
        .timeout(const Duration(seconds: 5));
    return OnboardingProgress.fromJson(
      jsonDecode(response.body) as Map<String, dynamic>,
    );
  }

  Future<OnboardingProgress> resumeOnboarding() async {
    final response = await http
        .post(_uri('/onboarding/resume'), headers: session.authHeaders)
        .timeout(const Duration(seconds: 5));
    return OnboardingProgress.fromJson(
      jsonDecode(response.body) as Map<String, dynamic>,
    );
  }

  Future<OnboardingProgress> completeOnboardingTask(String key) async {
    final response = await http
        .post(
          _uri('/onboarding/tasks/complete'),
          headers: session.authHeaders,
          body: jsonEncode({'key': key}),
        )
        .timeout(const Duration(seconds: 5));
    if (response.statusCode != 200 && response.statusCode != 201) {
      final body = _tryJson(response.body);
      throw Exception(body?['message']?.toString() ?? 'Could not complete task');
    }
    return OnboardingProgress.fromJson(
      jsonDecode(response.body) as Map<String, dynamic>,
    );
  }

  Future<OnboardingProgress> skipOnboardingTask(String key) async {
    final response = await http
        .post(
          _uri('/onboarding/tasks/skip'),
          headers: session.authHeaders,
          body: jsonEncode({'key': key}),
        )
        .timeout(const Duration(seconds: 5));
    if (response.statusCode != 200 && response.statusCode != 201) {
      final body = _tryJson(response.body);
      throw Exception(body?['message']?.toString() ?? 'Could not skip task');
    }
    return OnboardingProgress.fromJson(
      jsonDecode(response.body) as Map<String, dynamic>,
    );
  }

  Future<OnboardingProgress> stampOnboardingActivity(String flag) async {
    final response = await http
        .post(
          _uri('/onboarding/activity'),
          headers: session.authHeaders,
          body: jsonEncode({'flag': flag}),
        )
        .timeout(const Duration(seconds: 5));
    if (response.statusCode != 200 && response.statusCode != 201) {
      throw Exception('Activity stamp failed');
    }
    return OnboardingProgress.fromJson(
      jsonDecode(response.body) as Map<String, dynamic>,
    );
  }

  Future<OnboardingProgress> saveOnboardingProfile({
    required String name,
    required String phone,
    required String city,
    required String addressLine,
  }) async {
    final response = await http
        .post(
          _uri('/onboarding/profile'),
          headers: session.authHeaders,
          body: jsonEncode({
            'name': name,
            'phone': phone,
            'city': city,
            'addressLine': addressLine,
          }),
        )
        .timeout(const Duration(seconds: 5));
    if (response.statusCode != 200 && response.statusCode != 201) {
      final body = _tryJson(response.body);
      throw Exception(body?['message']?.toString() ?? 'Profile save failed');
    }
    session.applyProfile(
      name: name,
      phoneNumber: phone,
      cityName: city,
      address: addressLine,
    );
    return OnboardingProgress.fromJson(
      jsonDecode(response.body) as Map<String, dynamic>,
    );
  }

  Future<OnboardingProgress> saveOnboardingPreferences(String locale) async {
    final response = await http
        .post(
          _uri('/onboarding/preferences'),
          headers: session.authHeaders,
          body: jsonEncode({'locale': locale}),
        )
        .timeout(const Duration(seconds: 5));
    if (response.statusCode != 200 && response.statusCode != 201) {
      throw Exception('Preferences save failed');
    }
    return OnboardingProgress.fromJson(
      jsonDecode(response.body) as Map<String, dynamic>,
    );
  }

  Future<OnboardingProgress> postOnboarding(String path, [Map<String, dynamic>? body]) async {
    final response = await http
        .post(
          _uri('/onboarding$path'),
          headers: session.authHeaders,
          body: body == null ? null : jsonEncode(body),
        )
        .timeout(const Duration(seconds: 5));
    if (response.statusCode != 200 && response.statusCode != 201) {
      final parsed = _tryJson(response.body);
      throw Exception(parsed?['message']?.toString() ?? 'Onboarding action failed');
    }
    return OnboardingProgress.fromJson(
      jsonDecode(response.body) as Map<String, dynamic>,
    );
  }

  Future<void> trackAnalytics(
    String event,
    Map<String, Object> properties,
  ) async {
    if (session.accessToken == null) return;
    try {
      await http
          .post(
            _uri('/analytics/events'),
            headers: session.authHeaders,
            body: jsonEncode({'event': event, 'properties': properties}),
          )
          .timeout(const Duration(seconds: 3));
    } catch (_) {
      // Analytics must never break UX.
    }
  }

  Map<String, dynamic>? _tryJson(String body) {
    try {
      return jsonDecode(body) as Map<String, dynamic>;
    } catch (_) {
      return null;
    }
  }

  Product _productFromJson(Map<String, dynamic> json) {
    final stockStatusRaw = json['stockStatus'] as String? ?? 'inStock';
    return Product(
      id: json['id'] as String,
      name: json['name'] as String,
      brand: json['brand'] as String? ?? 'Winger',
      supplierId: json['supplierId'] as String? ?? 'supplier',
      supplierName: json['supplierName'] as String? ?? 'Supplier',
      supplierVerified: json['supplierVerified'] as bool? ?? false,
      price: (json['price'] as num).toDouble(),
      previousPrice: (json['previousPrice'] as num?)?.toDouble(),
      rating: (json['rating'] as num?)?.toDouble() ?? 4.5,
      imageUrl: json['imageUrl'] as String? ??
          'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800',
      category: json['category'] as String? ?? 'General',
      model: json['model'] as String? ?? 'Standard',
      color: json['color'] as String? ?? 'Default',
      size: json['size'] as String? ?? 'Standard',
      battery: json['battery'] as String? ?? '—',
      weight: json['weight'] as String? ?? '—',
      description: json['description'] as String? ?? '',
      stock: json['stock'] as int? ?? 0,
      stockStatus: switch (stockStatusRaw) {
        'lowStock' => StockStatus.lowStock,
        'outOfStock' => StockStatus.outOfStock,
        _ => StockStatus.inStock,
      },
    );
  }
}
