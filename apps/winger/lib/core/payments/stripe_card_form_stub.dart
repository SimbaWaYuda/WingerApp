import 'package:flutter/widgets.dart';

import 'stripe_card_handle.dart';

bool get usesHostedStripeCard => false;

class StripeCardForm extends StatelessWidget {
  const StripeCardForm({
    super.key,
    required this.handle,
    required this.frameUrl,
    required this.apiOrigin,
  });

  final StripeCardHandle handle;
  final String frameUrl;
  final String apiOrigin;

  @override
  Widget build(BuildContext context) => const SizedBox.shrink();
}
