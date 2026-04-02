export function formatPlanLabel(planCode?: string, fallbackName?: string) {
  switch ((planCode ?? '').toLowerCase()) {
    case 'vip1':
      return 'Pro'
    case 'vip2':
      return 'Pro Max'
    case 'free':
      return 'Free'
    case 'admin':
      return 'Admin'
    default:
      return fallbackName || planCode || ''
  }
}
