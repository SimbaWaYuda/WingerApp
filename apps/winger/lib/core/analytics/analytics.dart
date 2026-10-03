import '../api/api_client.dart';

/// Client analytics facade — forwards allow-listed events to the API (Mixpanel).
/// Never send email, password, tokens, or phone numbers.
class Analytics {
  Analytics(this.api);

  final ApiClient api;

  Future<void> onboardingStarted({required String role}) =>
      api.trackAnalytics('onboarding_started', {'role': role});

  Future<void> onboardingStepCompleted({
    required String role,
    required String taskKey,
  }) =>
      api.trackAnalytics('onboarding_step_completed', {
        'role': role,
        'task_key': taskKey,
      });

  Future<void> onboardingCompleted({required String role}) =>
      api.trackAnalytics('onboarding_completed', {'role': role});

  Future<void> firstMeaningfulAction({
    required String role,
    required String action,
  }) =>
      api.trackAnalytics('first_meaningful_action', {
        'role': role,
        'action': action,
      });
}
