package com.winger.winger

import com.stripe.android.ApiResultCallback
import com.stripe.android.Stripe
import com.stripe.android.model.PaymentMethod
import com.stripe.android.model.PaymentMethodCreateParams
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "winger/stripe")
            .setMethodCallHandler { call, result ->
                if (call.method != "createCardPaymentMethod") {
                    result.notImplemented()
                    return@setMethodCallHandler
                }
                val number = call.argument<String>("number")?.filter { it.isDigit() }.orEmpty()
                val expMonth = call.argument<Int>("expMonth") ?: 0
                val expYear = call.argument<Int>("expYear") ?: 0
                val cvc = call.argument<String>("cvc")?.filter { it.isDigit() }.orEmpty()
                val publishableKey = call.argument<String>("publishableKey")?.trim().orEmpty()
                if (!publishableKey.startsWith("pk_")) {
                    result.error("CARD", "Card payment is not configured", null)
                    return@setMethodCallHandler
                }
                val card = PaymentMethodCreateParams.Card.Builder()
                    .setNumber(number)
                    .setExpiryMonth(expMonth)
                    .setExpiryYear(expYear)
                    .setCvc(cvc)
                    .build()
                val params = PaymentMethodCreateParams.create(card)
                Stripe(applicationContext, publishableKey).createPaymentMethod(
                    params,
                    callback = object : ApiResultCallback<PaymentMethod> {
                        override fun onSuccess(paymentMethod: PaymentMethod) {
                            val id = paymentMethod.id
                            if (id.isNullOrBlank()) {
                                result.error("CARD", "Card could not be saved", null)
                            } else {
                                result.success(id)
                            }
                        }

                        override fun onError(e: Exception) {
                            result.error("CARD", e.localizedMessage ?: "Card could not be saved", null)
                        }
                    },
                )
            }
    }
}
