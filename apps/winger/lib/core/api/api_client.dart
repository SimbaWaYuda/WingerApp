import 'dart:convert';

import 'package:http/http.dart' as http;

import '../../features/onboarding/onboarding_models.dart';
import '../models/models.dart';
import '../state/app_session.dart';

class ApiClient {
  ApiClient(this.session);

  final AppSession session;

  Uri _uri(String path) => Uri.parse('${session.apiBaseUrl}$path');

  void _requireAccessToken() {
    final token = session.accessToken;
    if (token == null || token.isEmpty) {
      throw Exception(
        'Missing Bearer token — sign out and sign in again with API credentials (not local demo mode).',
      );
    }
  }

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

  Future<List<CatalogCategory>> fetchBrands() async {
    final response = await http
        .get(_uri('/products/brands'), headers: session.authHeaders)
        .timeout(const Duration(seconds: 3));
    if (response.statusCode != 200) {
      throw Exception('Brands HTTP ${response.statusCode}');
    }
    session.setApiOnline(true);
    final data = jsonDecode(response.body) as List<dynamic>;
    return data.map((raw) {
      final row = raw as Map<String, dynamic>;
      return CatalogCategory(
        name: row['name'] as String? ?? 'Brand',
        productCount: row['productCount'] as int? ?? 0,
      );
    }).toList();
  }

  Future<List<CatalogSupplier>> fetchSuppliers() async {
    final response = await http
        .get(_uri('/products/suppliers'), headers: session.authHeaders)
        .timeout(const Duration(seconds: 3));
    if (response.statusCode != 200) {
      throw Exception('Suppliers HTTP ${response.statusCode}');
    }
    session.setApiOnline(true);
    final data = jsonDecode(response.body) as List<dynamic>;
    return data.map((raw) {
      final row = raw as Map<String, dynamic>;
      return CatalogSupplier(
        id: row['id'] as String? ?? '',
        name: row['name'] as String? ?? 'Supplier',
        productCount: row['productCount'] as int? ?? 0,
      );
    }).where((s) => s.id.isNotEmpty).toList();
  }

  Future<List<CatalogCategory>> fetchColors() async {
    final response = await http
        .get(_uri('/products/colors'), headers: session.authHeaders)
        .timeout(const Duration(seconds: 3));
    if (response.statusCode != 200) {
      throw Exception('Colors HTTP ${response.statusCode}');
    }
    session.setApiOnline(true);
    final data = jsonDecode(response.body) as List<dynamic>;
    return data.map((raw) {
      final row = raw as Map<String, dynamic>;
      return CatalogCategory(
        name: row['name'] as String? ?? 'Color',
        productCount: row['productCount'] as int? ?? 0,
      );
    }).toList();
  }

  Future<List<CatalogCategory>> fetchSizes() async {
    final response = await http
        .get(_uri('/products/sizes'), headers: session.authHeaders)
        .timeout(const Duration(seconds: 3));
    if (response.statusCode != 200) {
      throw Exception('Sizes HTTP ${response.statusCode}');
    }
    session.setApiOnline(true);
    final data = jsonDecode(response.body) as List<dynamic>;
    return data.map((raw) {
      final row = raw as Map<String, dynamic>;
      return CatalogCategory(
        name: row['name'] as String? ?? 'Size',
        productCount: row['productCount'] as int? ?? 0,
      );
    }).toList();
  }

  Future<SupplierProfile> fetchSupplierProfile(String supplierId) async {
    final response = await http
        .get(_uri('/suppliers/$supplierId'), headers: session.authHeaders)
        .timeout(const Duration(seconds: 3));
    if (response.statusCode != 200) {
      throw Exception('Supplier profile HTTP ${response.statusCode}');
    }
    session.setApiOnline(true);
    final row = jsonDecode(response.body) as Map<String, dynamic>;
    return SupplierProfile(
      id: row['id'] as String? ?? supplierId,
      name: row['name'] as String? ?? 'Supplier',
      verified: row['verified'] as bool? ?? false,
      ratingAvg: (row['ratingAvg'] as num?)?.toDouble() ?? 0,
      ratingCount: row['ratingCount'] as int? ?? 0,
      productCount: row['productCount'] as int? ?? 0,
      businessBio: row['businessBio'] as String?,
      deliveryNotes: row['deliveryNotes'] as String?,
    );
  }

  Future<ProductPage> browseProducts({
    String query = '',
    String? category,
    String? brand,
    String? supplierId,
    String? color,
    String? size,
    double? minPrice,
    double? maxPrice,
    double? minRating,
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
      if (color != null && color.isNotEmpty) 'color': color,
      if (size != null && size.isNotEmpty) 'size': size,
      if (minPrice != null) 'minPrice': minPrice.toString(),
      if (maxPrice != null) 'maxPrice': maxPrice.toString(),
      if (minRating != null) 'minRating': minRating.toString(),
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

  Future<CartValidationResult> validateCart(
    List<CartItem> items, {
    String? deliveryMethod,
    String? city,
  }) async {
    final response = await http
        .post(
          _uri('/orders/validate'),
          headers: session.authHeaders,
          body: jsonEncode({
            'deliveryMethod': deliveryMethod ?? session.deliveryMethod,
            'city': city ?? session.city,
            'items': [
              for (final item in items)
                {
                  'productId': item.product.id,
                  'quantity': item.quantity,
                },
            ],
          }),
        )
        .timeout(const Duration(seconds: 8));
    if (response.statusCode != 200 && response.statusCode != 201) {
      final body = _tryJson(response.body);
      throw Exception(
        body?['message']?.toString() ??
            'Cart validation failed (${response.statusCode})',
      );
    }
    session.setApiOnline(true);
    final map = jsonDecode(response.body) as Map<String, dynamic>;
    final lines = (map['lines'] as List<dynamic>? ?? const [])
        .cast<Map<String, dynamic>>()
        .map((row) {
      final productJson = row['product'] as Map<String, dynamic>?;
      return CartValidationLine(
        productId: row['productId'] as String,
        available: row['available'] as bool? ?? false,
        reason: row['reason'] as String?,
        requestedQty: row['requestedQty'] as int? ?? 0,
        availableQty: row['availableQty'] as int? ?? 0,
        unitPrice: (row['unitPrice'] as num?)?.toDouble() ?? 0,
        lineTotal: (row['lineTotal'] as num?)?.toDouble() ?? 0,
        product: productJson == null ? null : _productFromJson(productJson),
      );
    }).toList();
    final shipments = (map['shipments'] as List<dynamic>? ?? const [])
        .cast<Map<String, dynamic>>()
        .map(
          (row) => CartShipmentQuote(
            supplierName: row['supplierName'] as String? ?? 'Supplier',
            deliveryMethod: row['deliveryMethod'] as String? ?? 'standard',
            fee: (row['fee'] as num?)?.toDouble() ?? 0,
            estimate: row['estimate'] as String? ?? '',
          ),
        )
        .toList();
    return CartValidationResult(
      ok: map['ok'] as bool? ?? false,
      subtotal: (map['subtotal'] as num?)?.toDouble() ?? 0,
      total: (map['total'] as num?)?.toDouble() ?? 0,
      deliveryFee: (map['deliveryFee'] as num?)?.toDouble() ?? 0,
      tax: (map['tax'] as num?)?.toDouble() ?? 0,
      deliveryMethod: map['deliveryMethod'] as String? ?? 'standard',
      shipments: shipments,
      lines: lines,
    );
  }

  Future<CustomerOrder> createOrder({
    required List<CartItem> items,
    String paymentMethod = 'card',
    String addressLine = 'Westlands',
    String city = 'Nairobi',
    String? deliveryMethod,
  }) async {
    final response = await http
        .post(
          _uri('/orders'),
          headers: session.authHeaders,
          body: jsonEncode({
            'paymentMethod': paymentMethod,
            'addressLine': addressLine,
            'city': city,
            'deliveryMethod': deliveryMethod ?? session.deliveryMethod,
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

  Future<CustomerOrder> fetchOrder(String orderId) async {
    final response = await http
        .get(_uri('/orders/$orderId'), headers: session.authHeaders)
        .timeout(const Duration(seconds: 5));
    if (response.statusCode != 200) {
      throw Exception('Order HTTP ${response.statusCode}');
    }
    session.setApiOnline(true);
    return customerOrderFromApi(jsonDecode(response.body) as Map<String, dynamic>);
  }

  Future<CustomerOrder> cancelOrder(String orderId) async {
    final response = await http
        .post(
          _uri('/orders/$orderId/cancel'),
          headers: session.authHeaders,
          body: jsonEncode({}),
        )
        .timeout(const Duration(seconds: 8));
    if (response.statusCode != 200 && response.statusCode != 201) {
      final body = _tryJson(response.body);
      throw Exception(
        body?['message']?.toString() ??
            'Cancel failed (${response.statusCode})',
      );
    }
    session.setApiOnline(true);
    return customerOrderFromApi(jsonDecode(response.body) as Map<String, dynamic>);
  }

  Future<void> createReturnRequest({
    required String orderId,
    required String orderItemId,
    required String reason,
    String? notes,
    int? quantity,
  }) async {
    final response = await http
        .post(
          _uri('/orders/$orderId/returns'),
          headers: session.authHeaders,
          body: jsonEncode({
            'orderItemId': orderItemId,
            'reason': reason,
            if (notes != null && notes.trim().isNotEmpty) 'notes': notes.trim(),
            if (quantity != null) 'quantity': quantity,
          }),
        )
        .timeout(const Duration(seconds: 8));
    if (response.statusCode != 200 && response.statusCode != 201) {
      final body = _tryJson(response.body);
      throw Exception(
        body?['message']?.toString() ??
            'Return request failed (${response.statusCode})',
      );
    }
    session.setApiOnline(true);
  }

  Future<List<OrderReturnRequest>> fetchReturnsInbox({String? status}) async {
    final uri = status != null && status.trim().isNotEmpty
        ? _uri('/orders/returns').replace(queryParameters: {'status': status.trim()})
        : _uri('/orders/returns');
    final response = await http
        .get(uri, headers: session.authHeaders)
        .timeout(const Duration(seconds: 8));
    if (response.statusCode != 200) {
      final body = _tryJson(response.body);
      throw Exception(
        body?['message']?.toString() ??
            'Returns HTTP ${response.statusCode}',
      );
    }
    session.setApiOnline(true);
    final data = jsonDecode(response.body) as List<dynamic>;
    return data
        .map((raw) => orderReturnRequestFromApi(raw as Map<String, dynamic>))
        .where((row) => row.id.isNotEmpty)
        .toList();
  }

  Future<OrderReturnRequest> updateReturnRequest({
    required String returnId,
    required String status,
  }) async {
    final response = await http
        .patch(
          _uri('/orders/returns/$returnId'),
          headers: session.authHeaders,
          body: jsonEncode({'status': status}),
        )
        .timeout(const Duration(seconds: 8));
    if (response.statusCode != 200) {
      final body = _tryJson(response.body);
      throw Exception(
        body?['message']?.toString() ??
            'Return update failed (${response.statusCode})',
      );
    }
    session.setApiOnline(true);
    return orderReturnRequestFromApi(
      jsonDecode(response.body) as Map<String, dynamic>,
    );
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

  Future<Map<String, dynamic>> fetchSupplierDashboard() async {
    _requireAccessToken();
    final response = await http
        .get(_uri('/suppliers/me/dashboard'), headers: session.authHeaders)
        .timeout(const Duration(seconds: 8));
    if (response.statusCode != 200) {
      final body = _tryJson(response.body);
      throw Exception(
        body?['message']?.toString() ??
            'Supplier dashboard HTTP ${response.statusCode}',
      );
    }
    session.setApiOnline(true);
    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  Future<List<Product>> fetchMyProducts() async {
    _requireAccessToken();
    final response = await http
        .get(_uri('/products/mine'), headers: session.authHeaders)
        .timeout(const Duration(seconds: 8));
    if (response.statusCode != 200) {
      final body = _tryJson(response.body);
      throw Exception(
        body?['message']?.toString() ??
            'My products HTTP ${response.statusCode}',
      );
    }
    session.setApiOnline(true);
    final data = jsonDecode(response.body) as List<dynamic>;
    return data
        .map((raw) => _productFromJson(raw as Map<String, dynamic>))
        .toList();
  }

  Future<Product> createMyProduct(Map<String, dynamic> body) async {
    _requireAccessToken();
    final response = await http
        .post(
          _uri('/products'),
          headers: session.authHeaders,
          body: jsonEncode(body),
        )
        .timeout(const Duration(seconds: 8));
    if (response.statusCode != 200 && response.statusCode != 201) {
      final err = _tryJson(response.body);
      throw Exception(
        err?['message']?.toString() ??
            'Create product failed (${response.statusCode})',
      );
    }
    session.setApiOnline(true);
    return _productFromJson(jsonDecode(response.body) as Map<String, dynamic>);
  }

  Future<Map<String, dynamic>> bulkImportProducts(
    List<Map<String, dynamic>> products,
  ) async {
    _requireAccessToken();
    if (products.isEmpty) {
      throw Exception('No products to import');
    }
    final response = await http
        .post(
          _uri('/products/bulk'),
          headers: session.authHeaders,
          body: jsonEncode({'products': products}),
        )
        .timeout(const Duration(seconds: 60));
    if (response.statusCode != 200 && response.statusCode != 201) {
      final err = _tryJson(response.body);
      throw Exception(
        err?['message']?.toString() ??
            'Bulk import failed (${response.statusCode})',
      );
    }
    session.setApiOnline(true);
    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  Future<Product> updateMyProduct(String id, Map<String, dynamic> body) async {
    _requireAccessToken();
    final response = await http
        .patch(
          _uri('/products/$id'),
          headers: session.authHeaders,
          body: jsonEncode(body),
        )
        .timeout(const Duration(seconds: 8));
    if (response.statusCode != 200) {
      final err = _tryJson(response.body);
      throw Exception(
        err?['message']?.toString() ??
            'Update product failed (${response.statusCode})',
      );
    }
    session.setApiOnline(true);
    return _productFromJson(jsonDecode(response.body) as Map<String, dynamic>);
  }

  Future<Product> uploadProductImages(String productId, List<String> paths) async {
    _requireAccessToken();
    if (paths.isEmpty) {
      throw Exception('Select at least one image to upload');
    }
    final request = http.MultipartRequest(
      'POST',
      _uri('/products/$productId/images'),
    );
    request.headers['Authorization'] = 'Bearer ${session.accessToken}';
    for (final path in paths) {
      request.files.add(await http.MultipartFile.fromPath('files', path));
    }
    final streamed = await request.send().timeout(const Duration(seconds: 30));
    final response = await http.Response.fromStream(streamed);
    if (response.statusCode != 200 && response.statusCode != 201) {
      final err = _tryJson(response.body);
      throw Exception(
        err?['message']?.toString() ??
            'Image upload failed (${response.statusCode})',
      );
    }
    session.setApiOnline(true);
    return _productFromJson(jsonDecode(response.body) as Map<String, dynamic>);
  }

  Future<Product> deleteProductImage(String productId, String imageId) async {
    _requireAccessToken();
    final response = await http
        .delete(
          _uri('/products/$productId/images/$imageId'),
          headers: {
            if (session.accessToken != null)
              'Authorization': 'Bearer ${session.accessToken}',
          },
        )
        .timeout(const Duration(seconds: 8));
    if (response.statusCode != 200) {
      final err = _tryJson(response.body);
      throw Exception(
        err?['message']?.toString() ??
            'Delete image failed (${response.statusCode})',
      );
    }
    session.setApiOnline(true);
    return _productFromJson(jsonDecode(response.body) as Map<String, dynamic>);
  }

  String resolveMediaUrl(String url) {
    final trimmed = url.trim();
    if (trimmed.isEmpty) return trimmed;
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed;
    }
    if (trimmed.startsWith('/')) {
      return '${session.apiBaseUrl}$trimmed';
    }
    return '${session.apiBaseUrl}/$trimmed';
  }

  Future<Map<String, dynamic>> fetchCommissionSettings() async {
    _requireAccessToken();
    final response = await http
        .get(_uri('/commissions/settings'), headers: session.authHeaders)
        .timeout(const Duration(seconds: 8));
    if (response.statusCode != 200) {
      throw Exception('Commission settings HTTP ${response.statusCode}');
    }
    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> updateDefaultCommissionRate(double percent) async {
    final response = await http
        .patch(
          _uri('/commissions/settings/default-rate'),
          headers: session.authHeaders,
          body: jsonEncode({'defaultCommissionPercent': percent}),
        )
        .timeout(const Duration(seconds: 8));
    if (response.statusCode != 200) {
      final body = _tryJson(response.body);
      throw Exception(
        body?['message']?.toString() ??
            'Update default commission failed (${response.statusCode})',
      );
    }
    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  Future<List<Map<String, dynamic>>> fetchCommissionAgreements({
    String? supplierId,
  }) async {
    _requireAccessToken();
    final query = supplierId != null
        ? '?supplierId=${Uri.encodeComponent(supplierId)}'
        : '';
    final response = await http
        .get(_uri('/commissions/agreements$query'), headers: session.authHeaders)
        .timeout(const Duration(seconds: 8));
    if (response.statusCode != 200) {
      throw Exception('Agreements HTTP ${response.statusCode}');
    }
    final data = jsonDecode(response.body) as List<dynamic>;
    return data.cast<Map<String, dynamic>>();
  }

  Future<Map<String, dynamic>> proposeCommissionAgreement({
    required String supplierId,
    required double ratePercent,
    String? notes,
  }) async {
    final response = await http
        .post(
          _uri('/commissions/agreements'),
          headers: session.authHeaders,
          body: jsonEncode({
            'supplierId': supplierId,
            'ratePercent': ratePercent,
            if (notes != null && notes.trim().isNotEmpty) 'notes': notes.trim(),
          }),
        )
        .timeout(const Duration(seconds: 8));
    if (response.statusCode != 200 && response.statusCode != 201) {
      final body = _tryJson(response.body);
      throw Exception(
        body?['message']?.toString() ??
            'Propose agreement failed (${response.statusCode})',
      );
    }
    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> commissionAgreementAction({
    required String agreementId,
    required String action,
    double? ratePercent,
    String? notes,
  }) async {
    final body = <String, dynamic>{
      if (ratePercent != null) 'ratePercent': ratePercent,
      if (notes != null && notes.trim().isNotEmpty) 'notes': notes.trim(),
    };
    final response = await http
        .post(
          _uri('/commissions/agreements/$agreementId/$action'),
          headers: session.authHeaders,
          body: jsonEncode(body),
        )
        .timeout(const Duration(seconds: 8));
    if (response.statusCode != 200 && response.statusCode != 201) {
      final err = _tryJson(response.body);
      throw Exception(
        err?['message']?.toString() ??
            'Agreement $action failed (${response.statusCode})',
      );
    }
    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> fetchSupplierCommissionSummary() async {
    _requireAccessToken();
    final response = await http
        .get(_uri('/commissions/supplier/summary'), headers: session.authHeaders)
        .timeout(const Duration(seconds: 8));
    if (response.statusCode != 200) {
      final body = _tryJson(response.body);
      throw Exception(
        body?['message']?.toString() ??
            'Commission summary HTTP ${response.statusCode}',
      );
    }
    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> fetchAdminSupplierCommissionTotals() async {
    _requireAccessToken();
    final response = await http
        .get(
          _uri('/commissions/admin/supplier-totals'),
          headers: session.authHeaders,
        )
        .timeout(const Duration(seconds: 8));
    if (response.statusCode != 200) {
      final body = _tryJson(response.body);
      throw Exception(
        body?['message']?.toString() ??
            'Supplier commission totals HTTP ${response.statusCode}',
      );
    }
    return jsonDecode(response.body) as Map<String, dynamic>;
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

  Future<void> submitSupplierReview({
    required String orderId,
    required String supplierId,
    required int rating,
    String? comment,
  }) async {
    final response = await http
        .post(
          _uri('/reviews'),
          headers: session.authHeaders,
          body: jsonEncode({
            'orderId': orderId,
            'supplierId': supplierId,
            'rating': rating,
            if (comment != null && comment.trim().isNotEmpty) 'comment': comment.trim(),
          }),
        )
        .timeout(const Duration(seconds: 8));
    if (response.statusCode != 200 && response.statusCode != 201) {
      final body = _tryJson(response.body);
      throw Exception(
        body?['message']?.toString() ??
            'Review failed (${response.statusCode})',
      );
    }
    session.setApiOnline(true);
  }

  Product _productFromJson(Map<String, dynamic> json) {
    final stockStatusRaw = json['stockStatus'] as String? ?? 'inStock';
    final rawImages = json['images'] as List<dynamic>? ?? const [];
    final images = rawImages
        .whereType<Map>()
        .map(
          (raw) => ProductImageRef(
            id: raw['id']?.toString() ?? '',
            url: resolveMediaUrl(raw['url']?.toString() ?? ''),
            sortOrder: (raw['sortOrder'] as num?)?.toInt() ?? 0,
          ),
        )
        .where((image) => image.id.isNotEmpty && image.url.isNotEmpty)
        .toList()
      ..sort((a, b) => a.sortOrder.compareTo(b.sortOrder));
    final rawCover = (json['imageUrl'] as String?)?.trim() ?? '';
    final cover = rawCover.isNotEmpty
        ? resolveMediaUrl(rawCover)
        : (images.isNotEmpty ? images.first.url : '');
    return Product(
      id: json['id'] as String,
      name: json['name'] as String,
      brand: json['brand'] as String? ?? 'Winger',
      supplierId: json['supplierId'] as String? ?? 'supplier',
      supplierName: json['supplierName'] as String? ?? 'Supplier',
      supplierVerified: json['supplierVerified'] as bool? ?? false,
      supplierRatingAvg: (json['supplierRatingAvg'] as num?)?.toDouble() ?? 0,
      supplierRatingCount: json['supplierRatingCount'] as int? ?? 0,
      price: (json['price'] as num).toDouble(),
      previousPrice: (json['previousPrice'] as num?)?.toDouble(),
      rating: (json['rating'] as num?)?.toDouble() ?? 4.5,
      imageUrl: cover,
      images: images.isNotEmpty
          ? images
          : (cover.isNotEmpty
              ? [ProductImageRef(id: 'cover-${json['id']}', url: cover)]
              : const []),
      category: json['category'] as String? ?? 'General',
      model: json['model'] as String? ?? 'Standard',
      color: json['color'] as String? ?? 'Default',
      size: json['size'] as String? ?? 'Standard',
      battery: json['battery'] as String? ?? '—',
      weight: json['weight'] as String? ?? '—',
      extraSpecs: (json['extraSpecs'] as List<dynamic>? ?? const [])
          .whereType<Map>()
          .map(
            (raw) => ProductSpec(
              label: raw['label']?.toString().trim() ?? '',
              value: raw['value']?.toString().trim() ?? '',
            ),
          )
          .where((spec) => spec.label.isNotEmpty && spec.value.isNotEmpty)
          .toList(),
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
