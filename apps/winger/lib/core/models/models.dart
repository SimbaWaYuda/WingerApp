enum UserRole { customer, supplier, admin }

enum OrderStatus {
  processing,
  readyForPickup,
  shipped,
  delivered,
  cancelled,
  returned,
  partial,
}

enum StockStatus { inStock, lowStock, outOfStock }

class ProductImageRef {
  const ProductImageRef({
    required this.id,
    required this.url,
    this.sortOrder = 0,
  });

  final String id;
  final String url;
  final int sortOrder;
}

class ProductSpec {
  const ProductSpec({required this.label, required this.value});

  final String label;
  final String value;
}

class Product {
  const Product({
    required this.id,
    required this.name,
    required this.brand,
    required this.supplierId,
    required this.supplierName,
    required this.price,
    required this.rating,
    required this.imageUrl,
    required this.category,
    this.images = const [],
    this.extraSpecs = const [],
    this.previousPrice,
    this.model = 'Standard',
    this.color = 'Graphite',
    this.size = 'One size',
    this.battery = '—',
    this.weight = '—',
    this.description = '',
    this.stock = 24,
    this.stockStatus = StockStatus.inStock,
    this.supplierVerified = false,
    this.supplierRatingAvg = 0,
    this.supplierRatingCount = 0,
  });

  final String id;
  final String name;
  final String brand;
  final String supplierId;
  final String supplierName;
  final bool supplierVerified;
  final double supplierRatingAvg;
  final int supplierRatingCount;
  final double price;
  final double? previousPrice;
  final double rating;
  final String imageUrl;
  final List<ProductImageRef> images;
  final List<ProductSpec> extraSpecs;
  final String category;
  final String model;
  final String color;
  final String size;
  final String battery;
  final String weight;
  final String description;
  final int stock;
  final StockStatus stockStatus;

  List<String> get galleryUrls {
    if (images.isNotEmpty) {
      return images
          .map((image) => image.url)
          .where((url) => url.trim().isNotEmpty)
          .toList();
    }
    if (imageUrl.trim().isNotEmpty) return [imageUrl];
    return const [];
  }

  /// Built-in + custom specs with empty / unused defaults removed.
  List<ProductSpec> get visibleSpecs {
    bool filled(String value, {Set<String> ignore = const {}}) {
      final trimmed = value.trim();
      if (trimmed.isEmpty || trimmed == '—') return false;
      return !ignore.contains(trimmed);
    }

    return [
      if (filled(model, ignore: {'Standard'})) ProductSpec(label: 'sku', value: model),
      if (filled(category, ignore: {'General'}))
        ProductSpec(label: 'categories', value: category),
      if (filled(color, ignore: {'Default', 'Graphite'}))
        ProductSpec(label: 'color', value: color),
      if (filled(size, ignore: {'Standard', 'One size'}))
        ProductSpec(label: 'size', value: size),
      if (filled(battery)) ProductSpec(label: 'battery', value: battery),
      if (filled(weight)) ProductSpec(label: 'weight', value: weight),
      ...extraSpecs.where(
        (spec) => spec.label.trim().isNotEmpty && filled(spec.value),
      ),
    ];
  }

  double get savings =>
      previousPrice == null ? 0 : (previousPrice! - price).clamp(0, double.infinity);
}

class CatalogCategory {
  const CatalogCategory({required this.name, required this.productCount});

  final String name;
  final int productCount;
}

class CatalogSupplier {
  const CatalogSupplier({
    required this.id,
    required this.name,
    required this.productCount,
  });

  final String id;
  final String name;
  final int productCount;
}

class SupplierProfile {
  const SupplierProfile({
    required this.id,
    required this.name,
    required this.verified,
    required this.ratingAvg,
    required this.ratingCount,
    required this.productCount,
    this.businessBio,
    this.deliveryNotes,
  });

  final String id;
  final String name;
  final bool verified;
  final double ratingAvg;
  final int ratingCount;
  final int productCount;
  final String? businessBio;
  final String? deliveryNotes;
}

class ProductPage {
  const ProductPage({
    required this.items,
    required this.total,
    required this.page,
    required this.pageSize,
    required this.totalPages,
  });

  final List<Product> items;
  final int total;
  final int page;
  final int pageSize;
  final int totalPages;
}

class CartItem {
  const CartItem({
    required this.product,
    required this.quantity,
  });

  final Product product;
  final int quantity;

  double get lineTotal => product.price * quantity;

  CartItem copyWith({Product? product, int? quantity}) {
    return CartItem(
      product: product ?? this.product,
      quantity: quantity ?? this.quantity,
    );
  }
}

class CartShipmentQuote {
  const CartShipmentQuote({
    required this.supplierName,
    required this.deliveryMethod,
    required this.fee,
    required this.estimate,
  });

  final String supplierName;
  final String deliveryMethod;
  final double fee;
  final String estimate;
}

class CartValidationResult {
  const CartValidationResult({
    required this.ok,
    required this.subtotal,
    required this.total,
    required this.deliveryFee,
    required this.tax,
    required this.lines,
    this.deliveryMethod = 'standard',
    this.shipments = const [],
  });

  final bool ok;
  final double subtotal;
  final double total;
  final double deliveryFee;
  final double tax;
  final String deliveryMethod;
  final List<CartShipmentQuote> shipments;
  final List<CartValidationLine> lines;
}

class CartValidationLine {
  const CartValidationLine({
    required this.productId,
    required this.available,
    required this.requestedQty,
    required this.availableQty,
    required this.unitPrice,
    required this.lineTotal,
    this.reason,
    this.product,
  });

  final String productId;
  final bool available;
  final String? reason;
  final int requestedQty;
  final int availableQty;
  final double unitPrice;
  final double lineTotal;
  final Product? product;
}

class ShipmentLeg {
  const ShipmentLeg({
    required this.supplierName,
    required this.productName,
    required this.status,
    this.trackingCode,
    this.pickupCode,
  });

  final String supplierName;
  final String productName;
  final OrderStatus status;
  final String? trackingCode;
  final String? pickupCode;
}

class CustomerOrder {
  const CustomerOrder({
    required this.id,
    required this.total,
    required this.status,
    required this.shipments,
    required this.placedAt,
    this.paymentStatus = 'PAID',
    this.paymentMode = 'demo',
    this.customerName = '',
    this.itemRows = const [],
    this.addressLine,
    this.city,
    this.paymentMethod,
    this.canRateSuppliers = const [],
    this.returnableItems = const [],
    this.returnRequests = const [],
  });

  final String id;
  final double total;
  final OrderStatus status;
  final List<ShipmentLeg> shipments;
  final DateTime placedAt;
  final String paymentStatus;
  final String paymentMode;
  final String? paymentMethod;
  final String customerName;
  final List<OrderItemRow> itemRows;
  final String? addressLine;
  final String? city;
  final List<RateableSupplier> canRateSuppliers;
  final List<ReturnableItem> returnableItems;
  final List<OrderReturnRequest> returnRequests;

  bool get canCancel {
    if (status == OrderStatus.cancelled) return false;
    final statuses = itemRows.isNotEmpty
        ? itemRows.map((item) => item.status)
        : <OrderStatus>[status];
    return statuses.every(
      (itemStatus) =>
          itemStatus != OrderStatus.shipped &&
          itemStatus != OrderStatus.delivered &&
          itemStatus != OrderStatus.cancelled,
    );
  }

  bool get canRequestReturn => returnableItems.isNotEmpty;

  /// Display ids of orders this one replaces (usually 0–1).
  List<String> get replacesOrderIds => itemRows
      .map((item) => item.replacesOrderId)
      .whereType<String>()
      .where((id) => id.isNotEmpty)
      .toSet()
      .toList();

  /// Display ids of replacement orders created from this order's returned lines.
  List<String> get replacedByOrderIds => itemRows
      .map((item) => item.replacedByOrderId)
      .whereType<String>()
      .where((id) => id.isNotEmpty)
      .toSet()
      .toList();

  bool get isReplacementOrder => replacesOrderIds.isNotEmpty;
}

class RateableSupplier {
  const RateableSupplier({
    required this.supplierId,
    required this.supplierName,
  });

  final String supplierId;
  final String supplierName;
}

class ReturnableItem {
  const ReturnableItem({
    required this.orderItemId,
    required this.productName,
    required this.supplierName,
    required this.quantity,
  });

  final String orderItemId;
  final String productName;
  final String supplierName;
  final int quantity;
}

class OrderReturnRequest {
  const OrderReturnRequest({
    required this.id,
    required this.orderItemId,
    required this.productName,
    required this.supplierName,
    required this.reason,
    required this.quantity,
    required this.status,
    required this.createdAt,
    this.orderId,
    this.notes,
    this.customerName,
  });

  final String id;
  final String? orderId;
  final String orderItemId;
  final String productName;
  final String supplierName;
  final String reason;
  final String? notes;
  final int quantity;
  final String status;
  final DateTime createdAt;
  final String? customerName;

  bool get canReview =>
      status == 'REQUESTED' || status == 'IN_REVIEW';
}

OrderReturnRequest orderReturnRequestFromApi(Map<String, dynamic> json) {
  return OrderReturnRequest(
    id: json['id'] as String? ?? '',
    orderId: json['orderId'] as String?,
    orderItemId: json['orderItemId'] as String? ?? '',
    productName: json['productName'] as String? ?? 'Product',
    supplierName: json['supplierName'] as String? ?? 'Supplier',
    reason: json['reason'] as String? ?? 'other',
    notes: json['notes'] as String?,
    quantity: json['quantity'] as int? ?? 1,
    status: json['status'] as String? ?? 'REQUESTED',
    createdAt: DateTime.tryParse(json['createdAt'] as String? ?? '') ??
        DateTime.now(),
    customerName: json['customerName'] as String?,
  );
}

class OrderItemRow {
  const OrderItemRow({
    required this.id,
    required this.productId,
    required this.productName,
    required this.supplierId,
    required this.supplierName,
    required this.quantity,
    required this.lineTotal,
    required this.status,
    this.trackingCode,
    this.pickupCode,
    this.replacesOrderId,
    this.replacesOrderItemId,
    this.replacedByOrderId,
  });

  final String id;
  final String productId;
  final String productName;
  final String supplierId;
  final String supplierName;
  final int quantity;
  final double lineTotal;
  final OrderStatus status;
  final String? trackingCode;
  final String? pickupCode;
  final String? replacesOrderId;
  final String? replacesOrderItemId;
  final String? replacedByOrderId;

  bool get isReplacement =>
      (replacesOrderId != null && replacesOrderId!.isNotEmpty) ||
      (replacesOrderItemId != null && replacesOrderItemId!.isNotEmpty);
}

class SupplierOrderRow {
  const SupplierOrderRow({
    required this.id,
    required this.customerName,
    required this.productName,
    required this.value,
    required this.status,
  });

  final String id;
  final String customerName;
  final String productName;
  final double value;
  final OrderStatus status;
}

OrderStatus orderStatusFromApi(String? raw) {
  switch ((raw ?? '').toUpperCase()) {
    case 'READY_FOR_PICKUP':
      return OrderStatus.readyForPickup;
    case 'SHIPPED':
      return OrderStatus.shipped;
    case 'DELIVERED':
      return OrderStatus.delivered;
    case 'CANCELLED':
      return OrderStatus.cancelled;
    case 'RETURNED':
      return OrderStatus.returned;
    case 'PARTIAL':
      return OrderStatus.partial;
    default:
      return OrderStatus.processing;
  }
}

String orderStatusToApi(OrderStatus status) {
  return switch (status) {
    OrderStatus.readyForPickup => 'READY_FOR_PICKUP',
    OrderStatus.shipped => 'SHIPPED',
    OrderStatus.delivered => 'DELIVERED',
    OrderStatus.cancelled => 'CANCELLED',
    OrderStatus.returned => 'RETURNED',
    OrderStatus.partial => 'PARTIAL',
    OrderStatus.processing => 'PROCESSING',
  };
}

CustomerOrder customerOrderFromApi(Map<String, dynamic> json) {
  final items = (json['items'] as List<dynamic>? ?? [])
      .cast<Map<String, dynamic>>();
  final rateable = (json['canRateSuppliers'] as List<dynamic>? ?? const [])
      .cast<Map<String, dynamic>>();
  final returnable = (json['returnableItems'] as List<dynamic>? ?? const [])
      .cast<Map<String, dynamic>>();
  final returns = (json['returnRequests'] as List<dynamic>? ?? const [])
      .cast<Map<String, dynamic>>();
  return CustomerOrder(
    id: (json['displayId'] as String?) ?? (json['id'] as String? ?? 'order'),
    total: (json['total'] as num?)?.toDouble() ?? 0,
    status: orderStatusFromApi(json['status'] as String?),
    paymentStatus: json['paymentStatus'] as String? ?? 'PENDING',
    paymentMode: json['paymentMode'] as String? ?? 'demo',
    paymentMethod: json['paymentMethod'] as String?,
    customerName: json['customerName'] as String? ?? '',
    addressLine: json['addressLine'] as String?,
    city: json['city'] as String?,
    placedAt: DateTime.tryParse(json['createdAt'] as String? ?? '') ??
        DateTime.now(),
    itemRows: [
      for (final item in items)
        OrderItemRow(
          id: item['id'] as String,
          productId: item['productId'] as String? ?? '',
          productName: item['productName'] as String? ?? '',
          supplierId: item['supplierId'] as String? ?? '',
          supplierName: item['supplierName'] as String? ?? '',
          quantity: item['quantity'] as int? ?? 1,
          lineTotal: (item['lineTotal'] as num?)?.toDouble() ?? 0,
          status: orderStatusFromApi(item['status'] as String?),
          trackingCode: item['trackingCode'] as String?,
          pickupCode: item['pickupCode'] as String?,
          replacesOrderId: item['replacesOrderId'] as String?,
          replacesOrderItemId: item['replacesOrderItemId'] as String?,
          replacedByOrderId: item['replacedByOrderId'] as String?,
        ),
    ],
    shipments: [
      for (final item in items)
        ShipmentLeg(
          supplierName: item['supplierName'] as String? ?? 'Supplier',
          productName: item['productName'] as String? ?? 'Product',
          status: orderStatusFromApi(item['status'] as String?),
          trackingCode: item['trackingCode'] as String?,
          pickupCode: item['pickupCode'] as String?,
        ),
    ],
    canRateSuppliers: [
      for (final row in rateable)
        RateableSupplier(
          supplierId: row['supplierId'] as String? ?? '',
          supplierName: row['supplierName'] as String? ?? 'Supplier',
        ),
    ].where((s) => s.supplierId.isNotEmpty).toList(),
    returnableItems: [
      for (final row in returnable)
        ReturnableItem(
          orderItemId: row['orderItemId'] as String? ?? '',
          productName: row['productName'] as String? ?? 'Product',
          supplierName: row['supplierName'] as String? ?? 'Supplier',
          quantity: row['quantity'] as int? ?? 1,
        ),
    ].where((item) => item.orderItemId.isNotEmpty).toList(),
    returnRequests: [
      for (final row in returns) orderReturnRequestFromApi(row),
    ].where((row) => row.id.isNotEmpty).toList(),
  );
}

class KpiCardData {
  const KpiCardData({
    required this.label,
    required this.value,
    required this.delta,
    this.positive = true,
  });

  final String label;
  final String value;
  final String delta;
  final bool positive;
}
