import { createRouter, createWebHistory } from 'vue-router'

import { LEGACY_ROUTE_REDIRECTS, ROOT_REDIRECT } from './route-redirects'
import { authState, hydrateAuthSession, isOnboardingUnlocked } from '../state/auth-state'
import DecisionLogsView from '../views/DecisionLogsView.vue'
import HomeView from '../views/HomeView.vue'
import LoginView from '../views/LoginView.vue'
import RegisterView from '../views/RegisterView.vue'
import SettingsView from '../views/SettingsView.vue'

export const appRoutes = [
  {
    path: '/',
    redirect: ROOT_REDIRECT,
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
    redirect: LEGACY_ROUTE_REDIRECTS['/onboarding'],
  },
  {
    path: '/quick-start',
    redirect: LEGACY_ROUTE_REDIRECTS['/quick-start'],
  },
  {
    path: '/home',
    name: 'home',
    component: HomeView,
    meta: { navLabel: 'Overview', requiresAuth: true },
  },
  {
    path: '/usage',
    redirect: LEGACY_ROUTE_REDIRECTS['/usage'],
  },
  {
    path: '/api-keys',
    redirect: LEGACY_ROUTE_REDIRECTS['/api-keys'],
  },
  {
    path: '/config',
    redirect: LEGACY_ROUTE_REDIRECTS['/config'],
  },
  {
    path: '/settings',
    name: 'settings',
    component: SettingsView,
    meta: { navLabel: 'Settings', requiresAuth: true },
  },
  {
    path: '/logs',
    name: 'logs',
    component: DecisionLogsView,
    meta: { navLabel: 'Chains', requiresAuth: true },
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: ROOT_REDIRECT,
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: appRoutes,
})

router.beforeEach(async (to) => {
  if (!authState.ready) {
    await hydrateAuthSession()
  }

  const isPublic = Boolean(to.meta?.publicRoute)
  const requiresAuth = Boolean(to.meta?.requiresAuth)
  const onboardingUnlocked = isOnboardingUnlocked()

  if (isPublic && authState.authenticated) {
    return onboardingUnlocked ? ROOT_REDIRECT : LEGACY_ROUTE_REDIRECTS['/onboarding']
  }
  if (requiresAuth && !authState.authenticated) {
    const redirectTarget = String(to.fullPath || ROOT_REDIRECT)
    return {
      path: '/login',
      query: { redirect: redirectTarget },
    }
  }
  if (requiresAuth && authState.authenticated && !onboardingUnlocked) return '/settings'
  return true
})

export default router
