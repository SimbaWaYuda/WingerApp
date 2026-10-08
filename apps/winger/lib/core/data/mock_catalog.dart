import '../models/models.dart';

abstract final class MockCatalog {
  static const products = <Product>[
    Product(
      id: 'p-aeropulse',
      name: 'AeroPulse ANC Headphones',
      brand: 'AeroPulse',
      supplierId: 's-kijani',
      supplierName: 'Kijani Tech',
      price: 249,
      previousPrice: 279,
      rating: 4.8,
      imageUrl: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800',
      category: 'Audio',
      model: 'AP700',
      color: 'Graphite',
      size: 'Standard',
      battery: '36h',
      weight: '248g',
      description:
          'Quiet cabin-ready ANC headphones with multi-point Bluetooth and USB-C fast charge.',
      stock: 42,
    ),
    Product(
      id: 'p-terraform',
      name: 'Terraform M6 Trail Pack',
      brand: 'Terraform',
      supplierId: 's-metals',
      supplierName: 'Metals Outdoor',
      price: 129,
      rating: 4.6,
      imageUrl: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=800',
      category: 'Bags',
      model: 'M6',
      color: 'Forest',
      size: '28L',
      battery: '—',
      weight: '890g',
      description: 'Weather-ready daypack with laptop sleeve and hydration port.',
      stock: 18,
      stockStatus: StockStatus.lowStock,
    ),
    Product(
      id: 'p-lumivolt',
      name: 'Lumivolt Desk Lamp',
      brand: 'Lumivolt',
      supplierId: 's-atlas',
      supplierName: 'Atlas Home',
      price: 89,
      previousPrice: 109,
      rating: 4.4,
      imageUrl: 'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?w=800',
      category: 'Home',
      model: 'LV-Desk',
      color: 'Matte White',
      size: 'Standard',
      battery: '—',
      weight: '1.1kg',
      description: 'Adjustable desk lamp with warm/cool modes for focused work.',
      stock: 64,
    ),
    Product(
      id: 'p-pulsewatch',
      name: 'Pulse Watch Pro',
      brand: 'Pulse',
      supplierId: 's-kijani',
      supplierName: 'Kijani Tech',
      price: 319,
      rating: 4.7,
      imageUrl: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=800',
      category: 'Wearables',
      model: 'PW-Pro',
      color: 'Midnight',
      size: '42mm',
      battery: '7d',
      weight: '38g',
      description: 'Training-ready smartwatch with GPS and recovery insights.',
      stock: 27,
    ),
    Product(
      id: 'p-soundfold',
      name: 'SoundFold Mini Speaker',
      brand: 'SoundFold',
      supplierId: 's-kijani',
      supplierName: 'Kijani Tech',
      price: 79,
      rating: 4.3,
      imageUrl: 'https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?w=800',
      category: 'Audio',
      model: 'SF-Mini',
      color: 'Sand',
      size: 'Compact',
      battery: '12h',
      weight: '310g',
      description: 'Portable Bluetooth speaker with punchy midrange for travel.',
      stock: 51,
    ),
    Product(
      id: 'p-northline',
      name: 'Northline Softshell Jacket',
      brand: 'Northline',
      supplierId: 's-metals',
      supplierName: 'Metals Outdoor',
      price: 168,
      rating: 4.5,
      imageUrl: 'https://images.unsplash.com/photo-1544022613-e87ca75a784a?w=800',
      category: 'Apparel',
      model: 'NL-Soft',
      color: 'Slate',
      size: 'M',
      battery: '—',
      weight: '420g',
      description: 'Wind-resistant softshell for city-to-trail days.',
      stock: 33,
    ),
    Product(
      id: 'p-aeropulse-savanna',
      name: 'AeroPulse ANC Headphones',
      brand: 'AeroPulse',
      supplierId: 's-savanna',
      supplierName: 'Savanna Electronics',
      supplierVerified: true,
      price: 229,
      previousPrice: 259,
      rating: 4.6,
      imageUrl: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800',
      category: 'Audio',
      model: 'AP700',
      color: 'Graphite',
      size: 'Standard',
      battery: '36h',
      weight: '248g',
      description:
          'Quiet cabin-ready ANC headphones with multi-point Bluetooth and USB-C fast charge.',
      stock: 35,
    ),
    Product(
      id: 'p-pulsewatch-savanna',
      name: 'Pulse Watch Pro',
      brand: 'Pulse',
      supplierId: 's-savanna',
      supplierName: 'Savanna Electronics',
      supplierVerified: true,
      price: 299,
      previousPrice: 329,
      rating: 4.5,
      imageUrl: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=800',
      category: 'Wearables',
      model: 'PW-Pro',
      color: 'Midnight',
      size: '42mm',
      battery: '7d',
      weight: '38g',
      description: 'Training-ready smartwatch with GPS and recovery insights.',
      stock: 22,
    ),
    Product(
      id: 'p-soundfold-savanna',
      name: 'SoundFold Mini Speaker',
      brand: 'SoundFold',
      supplierId: 's-savanna',
      supplierName: 'Savanna Electronics',
      supplierVerified: true,
      price: 69,
      rating: 4.2,
      imageUrl: 'https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?w=800',
      category: 'Audio',
      model: 'SF-Mini',
      color: 'Sand',
      size: 'Compact',
      battery: '12h',
      weight: '310g',
      description: 'Portable Bluetooth speaker with punchy midrange for travel.',
      stock: 48,
    ),
  ];

  static Product byId(String id) =>
      products.firstWhere((p) => p.id == id, orElse: () => products.first);

  static List<Product> search(String query) {
    final q = query.trim().toLowerCase();
    if (q.isEmpty) return products;
    return products
        .where(
          (p) =>
              p.name.toLowerCase().contains(q) ||
              p.brand.toLowerCase().contains(q) ||
              p.supplierName.toLowerCase().contains(q) ||
              p.category.toLowerCase().contains(q),
        )
        .toList();
  }

  static CustomerOrder get sampleOrder => CustomerOrder(
        id: 'WG-10025',
        total: 500.43,
        status: OrderStatus.partial,
        placedAt: DateTime.now().subtract(const Duration(days: 1)),
        shipments: const [
          ShipmentLeg(
            supplierName: 'Kijani Tech',
            productName: 'AeroPulse ANC Headphones',
            status: OrderStatus.shipped,
            trackingCode: 'KY-88421',
          ),
          ShipmentLeg(
            supplierName: 'Atlas Home',
            productName: 'Lumivolt Desk Lamp',
            status: OrderStatus.processing,
          ),
          ShipmentLeg(
            supplierName: 'Metals Outdoor',
            productName: 'Terraform M6 Trail Pack',
            status: OrderStatus.readyForPickup,
            pickupCode: 'PICK-2291',
          ),
        ],
      );

  static const supplierOrders = <SupplierOrderRow>[
    SupplierOrderRow(
      id: 'WG-10025',
      customerName: 'Amina Mwangi',
      productName: 'AeroPulse ANC Headphones',
      value: 249,
      status: OrderStatus.shipped,
    ),
    SupplierOrderRow(
      id: 'WG-10031',
      customerName: 'James Okello',
      productName: 'Pulse Watch Pro',
      value: 319,
      status: OrderStatus.processing,
    ),
    SupplierOrderRow(
      id: 'WG-10018',
      customerName: 'Sofia Neri',
      productName: 'SoundFold Mini Speaker',
      value: 79,
      status: OrderStatus.delivered,
    ),
  ];

  static const supplierKpis = <KpiCardData>[
    KpiCardData(label: 'Gross sales', value: '\$48,620', delta: '+8.4%'),
    KpiCardData(label: 'Orders', value: '186', delta: '+3.1%'),
    KpiCardData(label: 'Net payout', value: '\$42,786', delta: '+6.9%'),
    KpiCardData(label: 'Conversion', value: '4.8%', delta: '+0.4%'),
  ];

}
