import '../api/api_client.dart';
import '../data/mock_catalog.dart';
import '../models/models.dart';
import '../offline/offline_database.dart';
import '../offline/sync_engine.dart';

class CatalogRepository {
  CatalogRepository({
    required this.db,
    required this.api,
    required this.syncEngine,
  });

  final OfflineDatabase db;
  final ApiClient api;
  final SyncEngine syncEngine;

  Future<void> seedIfEmpty() async {
    if (await db.productCount() > 0) return;
    await db.upsertProducts(MockCatalog.products);
    for (final product in MockCatalog.products) {
      await db.upsertInventory(
        productId: product.id,
        supplierId: product.supplierId,
        quantity: product.stock,
      );
    }
  }

  Future<List<Product>> getProducts({String query = ''}) async {
    try {
      final remote = await api.fetchProducts(query: query);
      if (remote.isNotEmpty) {
        await db.upsertProducts(remote);
        for (final product in remote) {
          await db.upsertInventory(
            productId: product.id,
            supplierId: product.supplierId,
            quantity: product.stock,
          );
        }
        return remote;
      }
    } catch (_) {
      // Use local cache.
    }
    return db.getProducts(query: query);
  }

  Future<List<CatalogCategory>> getCategories() async {
    try {
      final remote = await api.fetchCategories();
      if (remote.isNotEmpty) return remote;
    } catch (_) {}
    final products = await db.getProducts();
    final counts = <String, int>{};
    for (final product in products) {
      counts[product.category] = (counts[product.category] ?? 0) + 1;
    }
    final names = counts.keys.toList()..sort();
    return [
      for (final name in names)
        CatalogCategory(name: name, productCount: counts[name]!),
    ];
  }

  Future<List<CatalogCategory>> getBrands() async {
    try {
      final remote = await api.fetchBrands();
      if (remote.isNotEmpty) return remote;
    } catch (_) {}
    final products = await db.getProducts();
    final counts = <String, int>{};
    for (final product in products) {
      counts[product.brand] = (counts[product.brand] ?? 0) + 1;
    }
    final names = counts.keys.toList()..sort();
    return [
      for (final name in names)
        CatalogCategory(name: name, productCount: counts[name]!),
    ];
  }

  Future<List<CatalogSupplier>> getSuppliers() async {
    try {
      final remote = await api.fetchSuppliers();
      if (remote.isNotEmpty) return remote;
    } catch (_) {}
    final products = await db.getProducts();
    final counts = <String, int>{};
    final names = <String, String>{};
    for (final product in products) {
      counts[product.supplierId] = (counts[product.supplierId] ?? 0) + 1;
      names[product.supplierId] = product.supplierName;
    }
    final ids = counts.keys.toList()
      ..sort((a, b) => (names[a] ?? a).compareTo(names[b] ?? b));
    return [
      for (final id in ids)
        CatalogSupplier(
          id: id,
          name: names[id] ?? id,
          productCount: counts[id]!,
        ),
    ];
  }

  Future<ProductPage> browseProducts({
    String query = '',
    String? category,
    String? brand,
    String? supplierId,
    double? minPrice,
    double? maxPrice,
    double? minRating,
    bool inStock = false,
    String sort = 'relevance',
    int page = 1,
    int pageSize = 24,
  }) async {
    try {
      final remote = await api.browseProducts(
        query: query,
        category: category,
        brand: brand,
        supplierId: supplierId,
        minPrice: minPrice,
        maxPrice: maxPrice,
        minRating: minRating,
        inStock: inStock,
        sort: sort,
        page: page,
        pageSize: pageSize,
      );
      if (remote.items.isNotEmpty) {
        await db.upsertProducts(remote.items);
      }
      return remote;
    } catch (_) {
      var local = await db.getProducts(query: query);
      if (category != null && category.isNotEmpty) {
        local = local
            .where((p) => p.category.toLowerCase() == category.toLowerCase())
            .toList();
      }
      if (brand != null && brand.isNotEmpty) {
        local = local
            .where((p) => p.brand.toLowerCase() == brand.toLowerCase())
            .toList();
      }
      if (supplierId != null && supplierId.isNotEmpty) {
        local = local.where((p) => p.supplierId == supplierId).toList();
      }
      if (minPrice != null) {
        local = local.where((p) => p.price >= minPrice).toList();
      }
      if (maxPrice != null) {
        local = local.where((p) => p.price <= maxPrice).toList();
      }
      if (minRating != null) {
        local = local.where((p) => p.rating >= minRating).toList();
      }
      if (inStock) {
        local = local.where((p) => p.stock > 0).toList();
      }
      local = _sortLocal(local, sort);
      final total = local.length;
      final start = ((page - 1) * pageSize).clamp(0, total);
      final end = (start + pageSize).clamp(0, total);
      return ProductPage(
        items: local.sublist(start, end),
        total: total,
        page: page,
        pageSize: pageSize,
        totalPages: total == 0 ? 1 : ((total + pageSize - 1) / pageSize).ceil(),
      );
    }
  }

  List<Product> _sortLocal(List<Product> products, String sort) {
    final copy = List<Product>.of(products);
    if (sort == 'price_asc') {
      copy.sort((a, b) => a.price.compareTo(b.price));
    } else if (sort == 'price_desc') {
      copy.sort((a, b) => b.price.compareTo(a.price));
    } else if (sort == 'rating' || sort == 'popularity') {
      copy.sort((a, b) => b.rating.compareTo(a.rating));
    } else {
      copy.sort((a, b) => a.name.compareTo(b.name));
    }
    return copy;
  }

  Future<Product> getProduct(String id) async {
    try {
      final remote = await api.fetchProduct(id);
      await db.upsertProducts([remote]);
      await db.upsertInventory(
        productId: remote.id,
        supplierId: remote.supplierId,
        quantity: remote.stock,
      );
      return remote;
    } catch (_) {
      return await db.getProduct(id) ?? MockCatalog.byId(id);
    }
  }
}
