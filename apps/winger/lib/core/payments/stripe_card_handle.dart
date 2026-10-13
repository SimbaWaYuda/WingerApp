class StripeCardHandle {
  Future<String> Function()? _create;

  void attach(Future<String> Function() create) {
    _create = create;
  }

  void detach() {
    _create = null;
  }

  Future<String> createPaymentMethod() {
    final create = _create;
    if (create == null) {
      throw Exception('Card form is not ready');
    }
    return create();
  }
}

String? paymentMethodIdFromCardMessage(Object? data) {
  if (data is! Map) return null;
  if (data['source'] != 'winger-card') return null;
  if (data['ok'] == true) {
    final id = data['id'];
    if (id is String && id.startsWith('pm_')) return id;
    throw Exception('Card could not be saved');
  }
  final message = data['message'];
  throw Exception(
    message is String && message.trim().isNotEmpty ? message.trim() : 'Card could not be saved',
  );
}
