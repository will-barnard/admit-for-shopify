<template>
  <header class="header">
    <h1>Convention Ticket Manager</h1>
    <div class="header-actions">
      <span>Welcome, {{ authStore.user?.username }}</span>
      <button @click="$emit('change-password')" class="btn-secondary">Change Password</button>
      <button @click="$emit('logout')" class="btn-secondary">Logout</button>
    </div>
  </header>
</template>

<script>
import { useAuthStore } from '@/stores/auth';

export default {
  name: 'PageHeader',
  emits: ['change-password', 'logout'],
  setup() {
    const authStore = useAuthStore();

    return {
      authStore,
    };
  },
};
</script>

<style scoped>
.header {
  background: white;
  padding: 20px 40px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header h1 {
  margin: 0;
  color: #333;
}

.header-actions {
  display: flex;
  gap: 15px;
  align-items: center;
}

.btn-secondary {
  background: white;
  color: #667eea;
  border: 2px solid #667eea;
  padding: 8px 16px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  transition: all 0.2s;
}

.btn-secondary:hover {
  background: #667eea;
  color: white;
}

@media (max-width: 768px) {
  .header {
    padding: 15px 20px;
    flex-direction: column;
    gap: 15px;
    align-items: stretch;
  }

  .header h1 {
    font-size: 20px;
    text-align: center;
  }

  .header-actions {
    flex-direction: column;
    gap: 10px;
    width: 100%;
  }

  .header-actions span {
    text-align: center;
    font-size: 14px;
  }

  .btn-secondary {
    width: 100%;
    padding: 10px;
    font-size: 13px;
  }
}

@media (max-width: 480px) {
  .header h1 {
    font-size: 18px;
  }
}
</style>
