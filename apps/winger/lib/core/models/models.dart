/// Expands legacy size text into selectable options.
/// Supports ranges (`36_42`, `36-42`) and lists (`S,M,L` / `36/37/38`).
List<String> expandSizeOptions(String? raw) {
  final value = (raw ?? '').trim();
  if (value.isEmpty) return const [];
  final lower = value.toLowerCase();
  if (const {'standard', 'one size', 'onesize', '—', '-'}.contains(lower)) {
    return const [];
  }

  final range = RegExp(
    r'^(\d+)\s*(?:_|-|–|—|to)\s*(\d+)$',
    caseSensitive: false,
  ).firstMatch(value);
  if (range != null) {
    final a = int.parse(range.group(1)!);
    final b = int.parse(range.group(2)!);
    final start = a < b ? a : b;
    final end = a < b ? b : a;
    if (end - start > 30) return [value];
    return [for (var i = start; i <= end; i++) '$i'];
  }

  final parts = value
      .split(RegExp(r'[,/;|]'))
      .map((part) => part.trim())
      .where((part) => part.isNotEmpty)
      .toList();
  if (parts.length > 1) return parts;
  return [value];
}

/// Splits legacy colour text into selectable swatches (`Pink,Black`).
List<String> expandColorOptions(String? raw) {
  final value = (raw ?? '').trim();
  if (value.isEmpty) return const [];
  final lower = value.toLowerCase();
  if (const {'default', 'graphite', '—', '-'}.contains(lower)) {
    return const [];
  }
  final parts = value
      .split(RegExp(r'[,/;|]'))
      .map((part) => part.trim())
      .where((part) => part.isNotEmpty)
      .toList();
  return parts.isEmpty ? const [] : parts;
}

String cartLineKey(
  String productId, {
  String? variantId,
  String? variantColor,
  String? variantSize,
}) {
  final id = (variantId ?? '').trim();
  if (id.isNotEmpty) return '$productId::$id';
  final color = (variantColor ?? '').trim().toLowerCase();
  final size = (variantSize ?? '').trim().toLowerCase();
  return '$productId::$color|$size';
}

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
    this.variantId,
    this.colorKey,
  });

  final String id;
  final String url;
  final int sortOrder;
  final String? variantId;
  final String? colorKey;
}

class ProductVariant {
  const ProductVariant({
    required this.id,
    this.color = '',
    this.size = '',
    this.colorHex,
    this.sku,
    this.stock = 0,
    this.stockStatus = StockStatus.outOfStock,
    this.enabled = true,
    this.sortOrder = 0,
    this.imageUrl,
  });

  final String id;
  final String color;
  final String size;
  final String? colorHex;
  final String? sku;
  final int stock;
  final StockStatus stockStatus;
  final bool enabled;
  final int sortOrder;
  final String? imageUrl;

  bool get isAvailable => enabled && stock > 0;

  String get label {
    final parts = <String>[
      if (color.trim().isNotEmpty) color.trim(),
      if (size.trim().isNotEmpty) size.trim(),
    ];
    return parts.isEmpty ? id : parts.join(' · ');
  }
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
    this.taxRatePercent,
    this.stock = 24,
    this.stockStatus = StockStatus.inStock,
    this.variants = const [],
    this.optionColors = const [],
    this.optionSizes = const [],
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

  /// Null uses the delivery-city rate, then the supplier rate.
  final double? taxRatePercent;
  final int stock;
  final StockStatus stockStatus;
  final List<ProductVariant> variants;
  final List<String> optionColors;
  final List<String> optionSizes;

  bool get hasVariants => variants.isNotEmpty;

  List<ProductVariant> get enabledVariants =>
      variants.where((row) => row.enabled).toList();

  /// Sizes customers can pick: real variants first, else expand legacy
  /// product.size values like `36_42` / `36-42` / `S,M,L`.
  List<String> get selectableSizes {
    if (optionSizes.isNotEmpty) return optionSizes;
    if (hasVariants) {
      final seen = <String>{};
      final out = <String>[];
      for (final row in enabledVariants) {
        final value = row.size.trim();
        if (value.isEmpty || !seen.add(value.toLowerCase())) continue;
        out.add(value);
      }
      return out;
    }
    return expandSizeOptions(size);
  }

  /// Colours customers can pick: real variants first, else split legacy color.
  List<String> get selectableColors {
    if (optionColors.isNotEmpty) return optionColors;
    if (hasVariants) {
      final seen = <String>{};
      final out = <String>[];
      for (final row in enabledVariants) {
        final value = row.color.trim();
        if (value.isEmpty || !seen.add(value.toLowerCase())) continue;
        out.add(value);
      }
      return out;
    }
    return expandColorOptions(color);
  }

  bool get offersOptionSelection =>
      selectableSizes.isNotEmpty || selectableColors.isNotEmpty;

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

  List<String> galleryUrlsForColor(String? color) {
    final key = (color ?? '').trim().toLowerCase();
    if (key.isEmpty) return galleryUrls;
    final matched = images
        .where(
          (image) =>
              (image.colorKey ?? '').trim().toLowerCase() == key ||
              variants.any(
                (variant) =>
                    variant.color.trim().toLowerCase() == key &&
                    variant.id == image.variantId,
              ),
        )
        .map((image) => image.url)
        .where((url) => url.trim().isNotEmpty)
        .toList();
    if (matched.isNotEmpty) return matched;
    final variantImage = enabledVariants
        .where((row) => row.color.trim().toLowerCase() == key)
        .map((row) => row.imageUrl)
        .whereType<String>()
        .where((url) => url.trim().isNotEmpty)
        .toList();
    if (variantImage.isNotEmpty) return variantImage;
    return galleryUrls;
  }

  ProductVariant? variantFor({String color = '', String size = ''}) {
    final c = color.trim().toLowerCase();
    final s = size.trim().toLowerCase();
    for (final row in enabledVariants) {
      if (row.color.trim().toLowerCase() == c &&
          row.size.trim().toLowerCase() == s) {
        return row;
      }
    }
    return null;
  }

  /// Built-in + custom specs with empty / unused defaults removed.
  /// Colour/size are omitted when offered as selectable options.
  List<ProductSpec> get visibleSpecs {
    bool filled(String value, {Set<String> ignore = const {}}) {
      final trimmed = value.trim();
      if (trimmed.isEmpty || trimmed == '—') return false;
      return !ignore.contains(trimmed);
    }

    return [
      if (filled(model, ignore: {'Standard'}))
        ProductSpec(label: 'sku', value: model),
      if (filled(category, ignore: {'General'}))
        ProductSpec(label: 'categories', value: category),
      if (selectableColors.isEmpty &&
          filled(color, ignore: {'Default', 'Graphite'}))
        ProductSpec(label: 'color', value: color),
      if (selectableSizes.isEmpty &&
          filled(size, ignore: {'Standard', 'One size'}))
        ProductSpec(label: 'size', value: size),
      if (filled(battery)) ProductSpec(label: 'battery', value: battery),
      if (filled(weight)) ProductSpec(label: 'weight', value: weight),
      ...extraSpecs.where(
        (spec) => spec.label.trim().isNotEmpty && filled(spec.value),
      ),
    ];
  }

  double get savings => previousPrice == null
      ? 0
      : (previousPrice! - price).clamp(0, double.infinity);
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

class SearchInterpretation {
  const SearchInterpretation({
    required this.source,
    this.q = '',
    this.category,
    this.brand,
    this.color,
    this.size,
    this.minPrice,
    this.maxPrice,
  });

  final String source;
  final String q;
  final String? category;
  final String? brand;
  final String? color;
  final String? size;
  final double? minPrice;
  final double? maxPrice;
}

class ProductPage {
  const ProductPage({
    required this.items,
    required this.total,
    required this.page,
    required this.pageSize,
    required this.totalPages,
    this.distanceReady = true,
    this.interpretation,
  });

  final List<Product> items;
  final int total;
  final int page;
  final int pageSize;
  final int totalPages;
  final bool distanceReady;
  final SearchInterpretation? interpretation;
}

const _blankSpecs = {
  '',
  'default',
  'standard',
  '—',
  '-',
  'n/a',
  'na',
  'none',
};

/// Null when the catalogue value is a placeholder such as "Default" or "Standard".
String? meaningfulSpec(String? value) {
  final trimmed = (value ?? '').trim();
  if (_blankSpecs.contains(trimmed.toLowerCase())) return null;
  return trimmed;
}

String? contactPhone(String? value) {
  final trimmed = (value ?? '').trim();
  if (trimmed.isEmpty || trimmed == '—' || trimmed == '-') return null;
  return trimmed;
}

String? orderSpecLabel({String? color, String? size}) {
  final parts = <String>[
    if (meaningfulSpec(color) != null) meaningfulSpec(color)!,
    if (meaningfulSpec(size) != null) meaningfulSpec(size)!,
  ];
  if (parts.isEmpty) return null;
  return parts.join(' · ');
}

class CartItem {
  const CartItem({
    required this.product,
    required this.quantity,
    this.variantId,
    this.variantColor,
    this.variantSize,
  });

  final Product product;
  final int quantity;
  final String? variantId;
  final String? variantColor;
  final String? variantSize;

  String get lineKey => cartLineKey(
    product.id,
    variantId: variantId,
    variantColor: variantColor,
    variantSize: variantSize,
  );

  String? get optionLabel {
    final selectedColor = meaningfulSpec(variantColor);
    final selectedSize = meaningfulSpec(variantSize);
    if (selectedColor != null || selectedSize != null) {
      return orderSpecLabel(color: selectedColor, size: selectedSize);
    }
    return orderSpecLabel(color: product.color, size: product.size);
  }

  int get availableStock {
    if (variantId == null || variantId!.isEmpty || !product.hasVariants) {
      return product.stock;
    }
    final match = product.variants.where((row) => row.id == variantId);
    if (match.isEmpty) return 0;
    return match.first.stock;
  }

  double get lineTotal => product.price * quantity;

  CartItem copyWith({
    Product? product,
    int? quantity,
    String? variantId,
    String? variantColor,
    String? variantSize,
  }) {
    return CartItem(
      product: product ?? this.product,
      quantity: quantity ?? this.quantity,
      variantId: variantId ?? this.variantId,
      variantColor: variantColor ?? this.variantColor,
      variantSize: variantSize ?? this.variantSize,
    );
  }
}

class CartShipmentQuote {
  const CartShipmentQuote({
    required this.supplierName,
    required this.deliveryMethod,
    required this.fee,
    required this.estimate,
    this.carrier,
    this.courierName,
  });

  final String supplierName;
  final String deliveryMethod;
  final double fee;
  final String estimate;
  final String? carrier;
  final String? courierName;
}

class LipaCheckoutTarget {
  const LipaCheckoutTarget({
    required this.supplierId,
    required this.supplierName,
    required this.merchantName,
    required this.lipaOrTillNumber,
    required this.network,
  });

  final String supplierId;
  final String supplierName;
  final String merchantName;
  final String lipaOrTillNumber;
  final String network;

  String get networkLabel {
    switch (network.toUpperCase()) {
      case 'M_PESA':
        return 'M-Pesa';
      case 'TIGO':
        return 'Tigo Pesa';
      case 'AIRTEL':
        return 'Airtel Money';
      case 'HALO':
        return 'Halopesa';
      default:
        return 'Mobile money';
    }
  }
}

LipaCheckoutTarget lipaCheckoutTargetFromApi(Map<String, dynamic> json) {
  return LipaCheckoutTarget(
    supplierId: json['supplierId'] as String? ?? '',
    supplierName: json['supplierName'] as String? ?? '',
    merchantName: json['merchantName'] as String? ?? '',
    lipaOrTillNumber: json['lipaOrTillNumber'] as String? ?? '',
    network: json['network'] as String? ?? '',
  );
}

String? carrierCaption({
  String? carrier,
  String? courierName,
  required String supplierDelivery,
  required String courierDelivery,
  required String unnamedCourier,
}) {
  if (carrier == 'supplier') return supplierDelivery;
  if (carrier == 'courier') {
    final name = (courierName ?? '').trim();
    if (name.isEmpty) return unnamedCourier;
    return courierDelivery.replaceAll('{name}', name);
  }
  return null;
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
    this.variantId,
    this.variantColor,
    this.variantSize,
    this.reason,
    this.product,
  });

  final String productId;
  final String? variantId;
  final String? variantColor;
  final String? variantSize;
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
    this.imageUrl,
    this.trackingCode,
    this.pickupCode,
    this.carrier,
    this.courierName,
    this.driverName,
    this.driverPhone,
    this.plateNumber,
    this.courierFee,
    this.trackingUrl,
    this.variantColor,
    this.variantSize,
  });

  final String supplierName;
  final String productName;
  final OrderStatus status;
  final String? imageUrl;
  final String? trackingCode;
  final String? pickupCode;
  final String? carrier;
  final String? courierName;
  final String? driverName;
  final String? driverPhone;
  final String? plateNumber;
  final double? courierFee;
  final String? trackingUrl;
  final String? variantColor;
  final String? variantSize;

  String? get specLabel =>
      orderSpecLabel(color: variantColor, size: variantSize);

  String get displayName {
    final spec = specLabel;
    if (spec == null) return productName;
    return '$productName ($spec)';
  }
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
    this.customerPhone,
    this.itemRows = const [],
    this.addressLine,
    this.city,
    this.paymentMethod,
    this.currency,
    this.displayCurrency,
    this.displayTotal,
    this.paymentCurrency,
    this.paymentAmount,
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
  final String? currency;
  final String? displayCurrency;
  final double? displayTotal;
  final String? paymentCurrency;
  final double? paymentAmount;
  final String customerName;
  final String? customerPhone;
  final List<OrderItemRow> itemRows;
  final String? addressLine;
  final String? city;
  final List<RateableSupplier> canRateSuppliers;
  final List<ReturnableItem> returnableItems;
  final List<OrderReturnRequest> returnRequests;

  String lockedAmountLabel() {
    final payCode = (paymentCurrency ?? currency ?? 'USD').toUpperCase();
    final pay = paymentAmount ?? total;
    if (displayTotal != null &&
        displayCurrency != null &&
        displayCurrency!.toUpperCase() != payCode) {
      return 'Est. ${displayCurrency!.toUpperCase()} ${displayTotal!.toStringAsFixed(2)} · Pay $payCode ${pay.toStringAsFixed(2)}';
    }
    return '$payCode ${pay.toStringAsFixed(2)}';
  }

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

  bool get isCodPending =>
      paymentMode == 'cod' && paymentStatus.toUpperCase() == 'PENDING';

  /// Cash on delivery or a Lipa payment the supplier has not confirmed yet.
  bool get awaitsSupplierCollection =>
      paymentStatus.toUpperCase() == 'PENDING' &&
      (paymentMode == 'cod' || paymentMode == 'lipa');

  bool get isPayOnDelivery =>
      paymentMode == 'cod' ||
      (paymentMethod?.toLowerCase().contains('pay_on_delivery') ?? false);

  /// Amount the customer hands over. Settlement [total] stays in USD.
  String customerPayLabel() {
    final code = (paymentCurrency ?? currency ?? 'USD').toUpperCase();
    final amount = paymentAmount ?? total;
    return '$code ${amount.toStringAsFixed(2)}';
  }

  bool get customerPaysOtherCurrency {
    final pay = (paymentCurrency ?? currency ?? 'USD').toUpperCase();
    final settlement = (currency ?? 'USD').toUpperCase();
    return pay != settlement;
  }

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
    this.variantColor,
    this.variantSize,
  });

  final String orderItemId;
  final String productName;
  final String supplierName;
  final int quantity;
  final String? variantColor;
  final String? variantSize;

  String get displayName {
    final parts = <String>[
      if ((variantColor ?? '').trim().isNotEmpty) variantColor!.trim(),
      if ((variantSize ?? '').trim().isNotEmpty) variantSize!.trim(),
    ];
    if (parts.isEmpty) return productName;
    return '$productName (${parts.join(' · ')})';
  }
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
    this.refundStatus = 'NONE',
    this.refundNote,
    this.refundedAt,
    this.paymentMode,
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
  final String refundStatus;
  final String? refundNote;
  final DateTime? refundedAt;
  final String? paymentMode;

  bool get isCardPayment => paymentMode == 'test' || paymentMode == 'live';

  bool get canReview => status == 'REQUESTED' || status == 'IN_REVIEW';

  bool get canManageRefund =>
      (status == 'APPROVED' || status == 'CLOSED') &&
      (refundStatus == 'PENDING' || refundStatus == 'NONE');
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
    createdAt:
        DateTime.tryParse(json['createdAt'] as String? ?? '') ?? DateTime.now(),
    customerName: json['customerName'] as String?,
    refundStatus: json['refundStatus'] as String? ?? 'NONE',
    refundNote: json['refundNote'] as String?,
    refundedAt: DateTime.tryParse(json['refundedAt'] as String? ?? ''),
    paymentMode: json['paymentMode'] as String?,
  );
}

class CustomerNotification {
  const CustomerNotification({
    required this.id,
    required this.type,
    required this.title,
    required this.body,
    required this.createdAt,
    this.entityType,
    this.entityId,
    this.readAt,
    this.whatsappStatus,
  });

  final String id;
  final String type;
  final String title;
  final String body;
  final String? entityType;
  final String? entityId;
  final DateTime? readAt;
  final String? whatsappStatus;
  final DateTime createdAt;

  bool get isUnread => readAt == null;
}

CustomerNotification customerNotificationFromApi(Map<String, dynamic> json) {
  return CustomerNotification(
    id: json['id'] as String? ?? '',
    type: json['type'] as String? ?? '',
    title: json['title'] as String? ?? '',
    body: json['body'] as String? ?? '',
    entityType: json['entityType'] as String?,
    entityId: json['entityId'] as String?,
    readAt: DateTime.tryParse(json['readAt'] as String? ?? ''),
    whatsappStatus: json['whatsappStatus'] as String?,
    createdAt:
        DateTime.tryParse(json['createdAt'] as String? ?? '') ?? DateTime.now(),
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
    this.imageUrl,
    this.variantId,
    this.variantColor,
    this.variantSize,
    this.trackingCode,
    this.pickupCode,
    this.carrier,
    this.courierName,
    this.driverName,
    this.driverPhone,
    this.plateNumber,
    this.courierFee,
    this.trackingUrl,
    this.replacesOrderId,
    this.replacesOrderItemId,
    this.replacedByOrderId,
  });

  final String id;
  final String productId;
  final String productName;
  final String? imageUrl;
  final String? variantId;
  final String? variantColor;
  final String? variantSize;
  final String supplierId;
  final String supplierName;
  final int quantity;
  final double lineTotal;
  final OrderStatus status;
  final String? trackingCode;
  final String? pickupCode;
  final String? carrier;
  final String? courierName;
  final String? driverName;
  final String? driverPhone;
  final String? plateNumber;
  final double? courierFee;
  final String? trackingUrl;
  final String? replacesOrderId;
  final String? replacesOrderItemId;
  final String? replacedByOrderId;

  String? get specLabel =>
      orderSpecLabel(color: variantColor, size: variantSize);

  String get displayName {
    final spec = specLabel;
    if (spec == null) return productName;
    return '$productName ($spec)';
  }

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

String? _bookingField(Map<String, dynamic> item, String key) {
  final booking = item['courierBooking'];
  if (booking is! Map) return null;
  final value = booking[key];
  if (value == null) return null;
  final text = value.toString().trim();
  return text.isEmpty ? null : text;
}

String? _orderImageUrl(Map<String, dynamic> item) {
  final raw = item['imageUrl'];
  if (raw == null) return null;
  final text = raw.toString().trim();
  return text.isEmpty ? null : text;
}

double? _bookingFee(Map<String, dynamic> item) {
  final booking = item['courierBooking'];
  if (booking is! Map) return null;
  final value = booking['fee'];
  if (value is num) return value.toDouble();
  return null;
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
    currency:
        json['settlementCurrency'] as String? ?? json['currency'] as String?,
    displayCurrency: json['displayCurrency'] as String?,
    displayTotal: (json['displayTotal'] as num?)?.toDouble(),
    paymentCurrency: json['paymentCurrency'] as String?,
    paymentAmount: (json['paymentAmount'] as num?)?.toDouble(),
    customerName: json['customerName'] as String? ?? '',
    customerPhone: contactPhone(json['customerPhone'] as String?),
    addressLine: json['addressLine'] as String?,
    city: json['city'] as String?,
    placedAt:
        DateTime.tryParse(json['createdAt'] as String? ?? '') ?? DateTime.now(),
    itemRows: [
      for (final item in items)
        OrderItemRow(
          id: item['id'] as String,
          productId: item['productId'] as String? ?? '',
          productName: item['productName'] as String? ?? '',
          imageUrl: _orderImageUrl(item),
          variantId: item['variantId'] as String?,
          variantColor: item['variantColor'] as String?,
          variantSize: item['variantSize'] as String?,
          supplierId: item['supplierId'] as String? ?? '',
          supplierName: item['supplierName'] as String? ?? '',
          quantity: item['quantity'] as int? ?? 1,
          lineTotal: (item['lineTotal'] as num?)?.toDouble() ?? 0,
          status: orderStatusFromApi(item['status'] as String?),
          trackingCode: item['trackingCode'] as String?,
          pickupCode: item['pickupCode'] as String?,
          carrier: item['carrier'] as String?,
          courierName: item['courierName'] as String?,
          driverName: _bookingField(item, 'driverName'),
          driverPhone: _bookingField(item, 'driverPhone'),
          plateNumber: _bookingField(item, 'plateNumber'),
          courierFee: _bookingFee(item),
          trackingUrl: _bookingField(item, 'trackingUrl'),
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
          imageUrl: _orderImageUrl(item),
          status: orderStatusFromApi(item['status'] as String?),
          trackingCode: item['trackingCode'] as String?,
          pickupCode: item['pickupCode'] as String?,
          carrier: item['carrier'] as String?,
          courierName: item['courierName'] as String?,
          driverName: _bookingField(item, 'driverName'),
          driverPhone: _bookingField(item, 'driverPhone'),
          plateNumber: _bookingField(item, 'plateNumber'),
          courierFee: _bookingFee(item),
          trackingUrl: _bookingField(item, 'trackingUrl'),
          variantColor: item['variantColor'] as String?,
          variantSize: item['variantSize'] as String?,
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
