import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import Login from '@/views/Login.vue';
import Home from '@/views/Home.vue';
import Events from '@/views/Events.vue';
import Tickets from '@/views/Tickets.vue';
import AddTicket from '@/views/AddTicket.vue';
import VerifyTicket from '@/views/VerifyTicket.vue';
import Stats from '@/views/Stats.vue';
import Settings from '@/views/Settings.vue';
import UserManagement from '@/views/UserManagement.vue';
import Webhooks from '@/views/Webhooks.vue';
import BulkEmail from '@/views/BulkEmail.vue';

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: Login,
  },
  {
    path: '/',
    name: 'Home',
    component: Home,
    meta: { requiresAuth: true },
  },
  {
    path: '/events',
    name: 'Events',
    component: Events,
    meta: { requiresAuth: true },
  },
  {
    path: '/tickets',
    name: 'Tickets',
    component: Tickets,
    meta: { requiresAuth: true },
  },
  {
    path: '/add-ticket',
    name: 'AddTicket',
    component: AddTicket,
    meta: { requiresAuth: true },
  },
  {
    path: '/stats',
    name: 'Stats',
    component: Stats,
    meta: { requiresAuth: true },
  },
  {
    path: '/settings',
    name: 'Settings',
    component: Settings,
    meta: { requiresAuth: true },
  },
  {
    path: '/users',
    name: 'UserManagement',
    component: UserManagement,
    meta: { requiresAuth: true, requiresSuperAdmin: true },
  },
  {
    path: '/webhooks',
    name: 'Webhooks',
    component: Webhooks,
    meta: { requiresAuth: true, requiresSuperAdmin: true },
  },
  {
    path: '/bulk-email',
    name: 'BulkEmail',
    component: BulkEmail,
    meta: { requiresAuth: true, requiresSuperAdmin: true },
  },
  {
    path: '/verify/:uuid',
    name: 'VerifyTicket',
    component: VerifyTicket,
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach((to, from, next) => {
  const authStore = useAuthStore();
  
  // Initialize auth headers if token exists
  authStore.initAuth();
  
  if (to.meta.requiresAuth && !authStore.isAuthenticated) {
    next('/login');
  } else if (to.path === '/login' && authStore.isAuthenticated) {
    next('/');
  } else if (to.meta.requiresSuperAdmin && authStore.user?.role !== 'superadmin') {
    next('/');
  } else {
    next();
  }
});

export default router;
