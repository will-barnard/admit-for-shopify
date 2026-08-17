import { defineStore } from 'pinia';
import axios from 'axios';
import { isEmbedded, shopDomain } from '@/shopify';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem('token') || null,
    user: JSON.parse(localStorage.getItem('user') || 'null'),
  }),

  getters: {
    /**
     * Embedded in the Shopify admin, identity comes from the App Bridge session
     * token attached per request - there is no stored token and no login page,
     * so the app counts as authenticated as soon as it loads.
     */
    isAuthenticated: (state) => isEmbedded() || !!state.token,

    /** Shopify staff acting on their own store get full rights. */
    effectiveRole: (state) => (isEmbedded() ? 'superadmin' : state.user?.role || null),

    isShopifyEmbedded: () => isEmbedded(),
    shop: () => shopDomain(),
  },

  actions: {
    async login(username, password) {
      try {
        const response = await axios.post('/api/auth/login', {
          username,
          password,
        });

        this.token = response.data.token;
        this.user = response.data.user;

        localStorage.setItem('token', response.data.token);
        localStorage.setItem('user', JSON.stringify(response.data.user));

        // Set default authorization header
        axios.defaults.headers.common['Authorization'] = `Bearer ${response.data.token}`;

        return true;
      } catch (error) {
        console.error('Login error:', error);
        throw error;
      }
    },

    logout() {
      this.token = null;
      this.user = null;
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      delete axios.defaults.headers.common['Authorization'];
    },

    initAuth() {
      // Embedded: the interceptor in shopify.js supplies the credential.
      if (isEmbedded()) return;
      if (this.token) {
        axios.defaults.headers.common['Authorization'] = `Bearer ${this.token}`;
      }
    },
  },
});
