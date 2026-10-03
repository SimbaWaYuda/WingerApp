class OnboardingTask {
  const OnboardingTask({
    required this.key,
    required this.required,
    required this.titleKey,
    required this.bodyKey,
    required this.completed,
    required this.skipped,
    required this.verified,
    required this.canComplete,
    this.route,
  });

  final String key;
  final bool required;
  final String titleKey;
  final String bodyKey;
  final bool completed;
  final bool skipped;
  final bool verified;
  final bool canComplete;
  final String? route;

  factory OnboardingTask.fromJson(Map<String, dynamic> json) {
    return OnboardingTask(
      key: json['key'] as String,
      required: json['required'] as bool? ?? false,
      titleKey: json['titleKey'] as String? ?? json['key'] as String,
      bodyKey: json['bodyKey'] as String? ?? '',
      completed: json['completed'] as bool? ?? false,
      skipped: json['skipped'] as bool? ?? false,
      verified: json['verified'] as bool? ?? false,
      canComplete: json['canComplete'] as bool? ?? false,
      route: json['route'] as String?,
    );
  }
}

class OnboardingProgress {
  const OnboardingProgress({
    required this.role,
    required this.isFirstTime,
    required this.requiredComplete,
    required this.checklistDismissed,
    required this.percent,
    required this.tasks,
    this.startedAt,
    this.completedAt,
  });

  final String role;
  final bool isFirstTime;
  final bool requiredComplete;
  final bool checklistDismissed;
  final int percent;
  final List<OnboardingTask> tasks;
  final String? startedAt;
  final String? completedAt;

  factory OnboardingProgress.fromJson(Map<String, dynamic> json) {
    final tasks = (json['tasks'] as List<dynamic>? ?? [])
        .cast<Map<String, dynamic>>()
        .map(OnboardingTask.fromJson)
        .toList();
    return OnboardingProgress(
      role: json['role'] as String? ?? '',
      isFirstTime: json['isFirstTime'] as bool? ?? true,
      requiredComplete: json['requiredComplete'] as bool? ?? false,
      checklistDismissed: json['checklistDismissed'] as bool? ?? false,
      percent: json['percent'] as int? ?? 0,
      startedAt: json['startedAt'] as String?,
      completedAt: json['completedAt'] as String?,
      tasks: tasks,
    );
  }
}
