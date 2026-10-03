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
