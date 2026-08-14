import { defineStore } from 'pinia';
import axios from 'axios';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    token: localStorage.getItem('verifier_token') || null,
  }),
  
  getters: {
    isAuthenticated: (state) => !!state.token,
  },
  
  actions: {
    async login(username, password) {
      try {
        const response = await axios.post('/api/auth/verifier-login', {
          username,
          password,
        });
        
        this.token = response.data.token;
        this.user = response.data.user;
        localStorage.setItem('verifier_token', this.token);
        axios.defaults.headers.common['Authorization'] = `Bearer ${this.token}`;
        
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error.response?.data?.error || 'Login failed',
        };
      }
    },
    
    logout() {
      this.user = null;
      this.token = null;
      localStorage.removeItem('verifier_token');
      delete axios.defaults.headers.common['Authorization'];
    },
    
    initAuth() {
      if (this.token) {
        axios.defaults.headers.common['Authorization'] = `Bearer ${this.token}`;
      }
    },
  },
});
