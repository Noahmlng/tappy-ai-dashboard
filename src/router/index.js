import { createRouter, createWebHistory } from 'vue-router'

import { authState, hydrateAuthSession, isOnboardingVerified } from '../state/auth-state'
import ApiKeysView from '../views/ApiKeysView.vue'
import DecisionLogsView from '../views/DecisionLogsView.vue'
import HomeView from '../views/HomeView.vue'
import LoginView from '../views/LoginView.vue'
import PlacementsView from '../views/PlacementsView.vue'
import QuickStartView from '../views/QuickStartView.vue'
import RegisterView from '../views/RegisterView.vue'
import UsageView from '../views/UsageView.vue'

const routes = [
  {
    path: '/',
    redirect: '/onboarding',
  },
  {
    path: '/login',
    name: 'login',
    component: LoginView,
    meta: { publicRoute: true },
  },
  {
    path: '/register',
    name: 'register',
    component: RegisterView,
    meta: { publicRoute: true },
  },
  {
    path: '/onboarding',
    name: 'onboarding',
    component: QuickStartView,
    meta: { navLabel: 'Onboarding', requiresAuth: true },
  },
  {
    path: '/quick-start',
    redirect: '/onboarding',
  },
  {
    path: '/home',
    name: 'home',
    component: HomeView,
    meta: { navLabel: 'Revenue', requiresAuth: true },
  },
  {
    path: '/usage',
    name: 'usage',
    component: UsageView,
    meta: { navLabel: 'Usage', requiresAuth: true },
  },
  {
    path: '/api-keys',
    name: 'apiKeys',
    component: ApiKeysView,
    meta: { navLabel: 'Key', requiresAuth: true },
  },
  {
    path: '/config',
    name: 'config',
    component: PlacementsView,
    meta: { navLabel: 'Placement', requiresAuth: true },
  },
  {
    path: '/logs',
    name: 'logs',
    component: DecisionLogsView,
    meta: { navLabel: 'Logs', requiresAuth: true },
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/home',
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

const PRE_VERIFY_ALLOWED_ROUTES = new Set([
  'onboarding',
])

router.beforeEach(async (to) => {
  if (!authState.ready) {
    await hydrateAuthSession()
  }

  const isPublic = Boolean(to.meta?.publicRoute)
  const requiresAuth = Boolean(to.meta?.requiresAuth)
  const onboardingVerified = isOnboardingVerified()

  if (isPublic && authState.authenticated) {
    return onboardingVerified ? '/home' : '/onboarding'
  }
  if (requiresAuth && !authState.authenticated) {
    const redirectTarget = String(to.fullPath || '/home')
    return {
      path: '/login',
      query: { redirect: redirectTarget },
    }
  }
  if (
    requiresAuth
    && authState.authenticated
    && !onboardingVerified
    && !PRE_VERIFY_ALLOWED_ROUTES.has(String(to.name || ''))
  ) {
    return '/onboarding'
  }
  return true
})

export default router
