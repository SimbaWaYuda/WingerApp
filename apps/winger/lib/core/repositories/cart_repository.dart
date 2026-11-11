import '../models/models.dart';
import '../offline/offline_database.dart';
import '../offline/sync_engine.dart';

class CartRepository {
  CartRepository({
    required this.db,
    required this.syncEngine,
  });

  final OfflineDatabase db;
  final SyncEngine syncEngine;

  Future<List<CartItem>> loadCart() => db.loadCart();

  Future<void> upsert(
    Product product,
    int quantity, {
    String? variantId,
    String? variantColor,
    String? variantSize,
  }) async {
    await db.upsertProducts([product]);
    if (quantity <= 0) {
      await remove(product.id, variantId: variantId);
      return;
    }
    await db.upsertCartLine(
      product.id,
      quantity,
      variantId: variantId,
      variantColor: variantColor,
      variantSize: variantSize,
    );
    await syncEngine.enqueue(
      operation: SyncOperation.cartUpsert,
      payload: {
        'productId': product.id,
        'quantity': quantity,
        if (variantId != null && variantId.isNotEmpty) 'variantId': variantId,
        if (variantColor != null) 'variantColor': variantColor,
        if (variantSize != null) 'variantSize': variantSize,
      },
    );
  }

  Future<void> remove(String productId, {String? variantId}) async {
    await db.removeCartLine(productId, variantId: variantId);
    await syncEngine.enqueue(
      operation: SyncOperation.cartRemove,
      payload: {
        'productId': productId,
        if (variantId != null && variantId.isNotEmpty) 'variantId': variantId,
      },
    );
  }

  Future<void> clear() async {
    final ids = await db.clearCart();
    for (final productId in ids) {
      await syncEngine.enqueue(
        operation: SyncOperation.cartRemove,
        payload: {'productId': productId},
      );
    }
  }
}
