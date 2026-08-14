<template>
  <div class="home">
    <PageHeader @change-password="showChangePassword" @logout="handleLogout" />

    <ChangePasswordModal v-if="isChangePasswordOpen" @close="isChangePasswordOpen = false" />

    <div class="container">
      <nav class="nav-tabs">
        <router-link to="/" class="nav-tab" exact-active-class="active">Dashboard</router-link>
        <router-link to="/events" class="nav-tab" active-class="active">Events</router-link>
        <router-link to="/tickets" class="nav-tab" active-class="active">Tickets</router-link>
        <router-link to="/stats" class="nav-tab" active-class="active">Stats</router-link>
        <router-link to="/settings" class="nav-tab" active-class="active">Settings</router-link>
        <router-link v-if="authStore.user?.role === 'superadmin'" to="/users" class="nav-tab" active-class="active">Users</router-link>
        <router-link v-if="authStore.user?.role === 'superadmin'" to="/webhooks" class="nav-tab" active-class="active">Webhooks</router-link>
        <router-link v-if="authStore.user?.role === 'superadmin'" to="/bulk-email" class="nav-tab" active-class="active">Bulk Email</router-link>
      </nav>

      <div v-if="loading" class="loading">Loading stats...</div>

      <div v-else-if="error" class="error-message">
        {{ error }}
      </div>

      <div v-else class="stats-dashboard">
        <h2>Overview</h2>
        
        <div class="stats-grid">
          <div class="stat-card total">
            <div class="stat-icon">
              <font-awesome-icon icon="ticket" />
            </div>
            <div class="stat-content">
              <div class="stat-value">{{ stats.totals?.sold || 0 }}</div>
              <div class="stat-label">Total Tickets</div>
            </div>
          </div>

          <div class="stat-card used">
            <div class="stat-icon">
              <font-awesome-icon icon="check" />
            </div>
            <div class="stat-content">
              <div class="stat-value">{{ stats.totals?.scanned || 0 }}</div>
              <div class="stat-label">Total Check-ins</div>
            </div>
          </div>
          
          <div class="stat-card attendee">
            <div class="stat-icon">
              <font-awesome-icon icon="calendar-day" />
            </div>
            <div class="stat-content">
              <div class="stat-value">{{ (stats.eventStats || []).length }}</div>
              <div class="stat-label">Active Events</div>
            </div>
          </div>
        </div>

        <div v-if="stats.eventStats && stats.eventStats.length > 0" class="event-stats-section">
          <h3>Events</h3>
          <div class="event-stats-grid">
            <div v-for="event in stats.eventStats" :key="event.eventId" class="event-stat-card">
              <div class="event-stat-header">
                <h4>{{ event.eventName }}</h4>
                <span v-if="event.eventDate" class="event-date">{{ formatDate(event.eventDate) }}</span>
              </div>
              <div class="event-stat-numbers">
                <div class="event-num">
                  <span class="num-value">{{ event.sold }}</span>
                  <span class="num-label">Sold</span>
                </div>
                <div class="event-num">
                  <span class="num-value scanned">{{ event.scanned }}</span>
                  <span class="num-label">Scanned</span>
                </div>
                <div class="event-num">
                  <span class="num-value">{{ event.remaining }}</span>
                  <span class="num-label">Remaining</span>
                </div>
              </div>
              <div class="progress-bar">
                <div class="progress-fill" :style="{ width: getPercentage(event) + '%' }"></div>
              </div>
            </div>
          </div>
        </div>

        <div class="quick-actions">
          <h3>Quick Actions</h3>
          <div class="action-buttons">
            <button @click="goToAddTicket" class="action-btn">
              <span class="icon">➕</span>
              <span>Add New Ticket</span>
            </button>
            <button @click="goToTickets" class="action-btn">
              <span class="icon">📋</span>
              <span>View All Tickets</span>
            </button>
            <button @click="goToEvents" class="action-btn">
              <span class="icon">🎪</span>
              <span>Manage Events</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import axios from 'axios';
import ChangePasswordModal from '@/components/ChangePasswordModal.vue';
import PageHeader from '@/components/PageHeader.vue';

export default {
  name: 'Home',
  components: {
    ChangePasswordModal,
    PageHeader,
  },
  setup() {
    const router = useRouter();
    const authStore = useAuthStore();

    const stats = ref({});
    const loading = ref(true);
    const error = ref('');
    const isChangePasswordOpen = ref(false);

    const getPercentage = (event) => {
      if (!event.sold || event.sold === 0) return 0;
      return Math.round((event.scanned / event.sold) * 100);
    };

    const formatDate = (dateString) => {
      if (!dateString) return '';
      return new Date(dateString).toLocaleDateString();
    };

    const loadStats = async () => {
      loading.value = true;
      error.value = '';
      
      try {
        const response = await axios.get('/api/stats');
        stats.value = response.data;
      } catch (err) {
        console.error('Error loading stats:', err);
        error.value = 'Failed to load stats. Please try again.';
      } finally {
        loading.value = false;
      }
    };

    const goToAddTicket = () => {
      router.push('/add-ticket');
    };

    const goToTickets = () => {
      router.push('/tickets');
    };

    const goToEvents = () => {
      router.push('/events');
    };

    const showChangePassword = () => {
      isChangePasswordOpen.value = true;
    };

    const handleLogout = () => {
      authStore.logout();
      router.push('/login');
    };

    onMounted(() => {
      authStore.initAuth();
      loadStats();
    });

    return {
      authStore,
      stats,
      loading,
      error,
      isChangePasswordOpen,
      getPercentage,
      formatDate,
      goToAddTicket,
      goToTickets,
      goToEvents,
      showChangePassword,
      handleLogout,
    };
  },
};
</script>

<style scoped>
.home {
  min-height: 100vh;
  background: #f5f5f5;
}

.container {
  max-width: 1400px;
  margin: 0 auto;
  padding: 30px;
}

.nav-tabs {
  display: flex;
  gap: 10px;
  margin-bottom: 30px;
  border-bottom: 2px solid #e0e0e0;
}

.nav-tab {
  padding: 12px 24px;
  text-decoration: none;
  color: #666;
  border-bottom: 3px solid transparent;
  margin-bottom: -2px;
  transition: all 0.2s;
  font-weight: 500;
}

.nav-tab:hover {
  color: #667eea;
}

.nav-tab.active {
  color: #667eea;
  border-bottom-color: #667eea;
}

.stats-dashboard h2 {
  color: #333;
  margin-bottom: 30px;
  font-size: 28px;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 20px;
  margin-bottom: 40px;
}

.stat-card {
  background: white;
  padding: 30px;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  display: flex;
  align-items: center;
  gap: 20px;
  transition: transform 0.2s, box-shadow 0.2s;
}

.stat-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}

.stat-icon {
  font-size: 48px;
  width: 70px;
  height: 70px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  flex-shrink: 0;
}

.stat-content {
  flex: 1;
}

.stat-value {
  font-size: 36px;
  font-weight: bold;
  color: #333;
}

.stat-label {
  font-size: 14px;
  color: #666;
  margin-top: 5px;
}

.stat-card.total {
  border-left: 4px solid #667eea;
}

.stat-card.used {
  border-left: 4px solid #9E9E9E;
}

.stat-card.attendee {
  border-left: 4px solid #2196F3;
}

.event-stats-section {
  margin-bottom: 40px;
}

.event-stats-section h3 {
  color: #333;
  margin-bottom: 20px;
  font-size: 20px;
}

.event-stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 20px;
}

.event-stat-card {
  background: white;
  padding: 24px;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  transition: transform 0.2s, box-shadow 0.2s;
}

.event-stat-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}

.event-stat-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 16px;
}

.event-stat-header h4 {
  margin: 0;
  color: #333;
  font-size: 16px;
}

.event-date {
  font-size: 13px;
  color: #999;
  white-space: nowrap;
}

.event-stat-numbers {
  display: flex;
  gap: 20px;
  margin-bottom: 12px;
}

.event-num {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.num-value {
  font-size: 24px;
  font-weight: bold;
  color: #333;
}

.num-value.scanned {
  color: #4CAF50;
}

.num-label {
  font-size: 12px;
  color: #999;
  margin-top: 2px;
}

.progress-bar {
  height: 6px;
  background: #e0e0e0;
  border-radius: 3px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #667eea, #764ba2);
  transition: width 0.3s;
}

.quick-actions {
  background: white;
  padding: 30px;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

.quick-actions h3 {
  margin: 0 0 20px 0;
  color: #333;
  font-size: 20px;
}

.action-buttons {
  display: flex;
  gap: 15px;
  flex-wrap: wrap;
}

.action-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 15px 30px;
  background: #667eea;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 16px;
  cursor: pointer;
  transition: background 0.2s;
}

.action-btn:hover {
  background: #5568d3;
}

.action-btn .icon {
  font-size: 20px;
}

.loading {
  text-align: center;
  padding: 40px;
  color: #666;
  font-size: 18px;
}

.error-message {
  background: #fee;
  color: #c33;
  padding: 15px;
  border-radius: 5px;
  text-align: center;
}

.btn-primary, .btn-secondary {
  padding: 10px 20px;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  font-size: 14px;
  transition: opacity 0.2s;
}

.btn-primary {
  background: #667eea;
  color: white;
}

.btn-primary:hover {
  opacity: 0.9;
}

.btn-secondary {
  background: white;
  color: #667eea;
  border: 1px solid #667eea;
}

.btn-secondary:hover {
  background: #f0f0ff;
}

@media (max-width: 768px) {
  .container {
    padding: 15px;
  }

  .nav-tabs {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }

  .nav-tabs::-webkit-scrollbar {
    display: none;
  }

  .nav-tab {
    padding: 10px 16px;
    font-size: 14px;
    white-space: nowrap;
  }

  .stats-dashboard h2 {
    font-size: 22px;
  }

  .stats-grid {
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px;
  }

  .stat-card {
    padding: 15px;
  }

  .stat-icon {
    font-size: 28px;
    margin-bottom: 8px;
  }

  .stat-value {
    font-size: 24px;
  }

  .stat-label {
    font-size: 11px;
  }

  .quick-actions h3 {
    font-size: 18px;
  }

  .action-buttons {
    flex-direction: column;
    gap: 12px;
  }

  .action-btn {
    width: 100%;
    padding: 12px 20px;
    font-size: 14px;
  }
}
</style>
