<template>
  <div class="stats">
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

      <div v-if="loading" class="loading">Loading statistics...</div>

      <div v-else-if="error" class="error-message">
        {{ error }}
      </div>

      <div v-else class="stats-content">
        <h2>Ticket Statistics</h2>
        
        <!-- Per-Event Stats -->
        <div class="stats-section">
          <h3>By Event</h3>
          <div class="stats-table">
            <div class="stats-table-header">
              <div class="stats-col event-name">Event</div>
              <div class="stats-col">Sold</div>
              <div class="stats-col">Scanned</div>
              <div class="stats-col">Remaining</div>
              <div class="stats-col progress">Progress</div>
            </div>
            
            <div v-for="event in eventStats" :key="event.event_id" class="stats-table-row">
              <div class="stats-col event-name">{{ event.event_name }}</div>
              <div class="stats-col">{{ event.sold }}</div>
              <div class="stats-col scanned-value">{{ event.scanned }}</div>
              <div class="stats-col">{{ event.remaining }}</div>
              <div class="stats-col progress">
                <div class="progress-bar">
                  <div class="progress-fill" :style="{ width: getPercentage(event) + '%' }"></div>
                </div>
                <span class="progress-text">{{ getPercentage(event) }}%</span>
              </div>
            </div>

            <div v-if="eventStats.length === 0" class="stats-table-row">
              <div class="stats-col event-name" style="color: #999;">No events found</div>
              <div class="stats-col">-</div>
              <div class="stats-col">-</div>
              <div class="stats-col">-</div>
              <div class="stats-col">-</div>
            </div>
          </div>
        </div>

        <!-- Grand Total Section -->
        <div class="stats-section grand-total">
          <h3>Grand Total</h3>
          <div class="stats-table">
            <div class="stats-table-header">
              <div class="stats-col event-name">All Events</div>
              <div class="stats-col">Sold</div>
              <div class="stats-col">Scanned</div>
              <div class="stats-col">Remaining</div>
              <div class="stats-col progress">Progress</div>
            </div>
            <div class="stats-table-row total-row">
              <div class="stats-col event-name"><strong>Grand Total</strong></div>
              <div class="stats-col"><strong>{{ grandTotal.sold }}</strong></div>
              <div class="stats-col scanned-value"><strong>{{ grandTotal.scanned }}</strong></div>
              <div class="stats-col"><strong>{{ grandTotal.remaining }}</strong></div>
              <div class="stats-col progress">
                <div class="progress-bar">
                  <div class="progress-fill grand-total" :style="{ width: getPercentage(grandTotal) + '%' }"></div>
                </div>
                <span class="progress-text"><strong>{{ getPercentage(grandTotal) }}%</strong></span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import axios from 'axios';
import ChangePasswordModal from '@/components/ChangePasswordModal.vue';
import PageHeader from '@/components/PageHeader.vue';

export default {
  name: 'Stats',
  components: {
    ChangePasswordModal,
    PageHeader,
  },
  setup() {
    const router = useRouter();
    const authStore = useAuthStore();

    const eventStats = ref([]);
    const loading = ref(true);
    const error = ref('');
    const isChangePasswordOpen = ref(false);

    const grandTotal = computed(() => {
      return {
        sold: eventStats.value.reduce((sum, e) => sum + e.sold, 0),
        scanned: eventStats.value.reduce((sum, e) => sum + e.scanned, 0),
        remaining: eventStats.value.reduce((sum, e) => sum + e.remaining, 0),
      };
    });

    const getPercentage = (stats) => {
      if (stats.sold === 0) return 0;
      return Math.round((stats.scanned / stats.sold) * 100);
    };

    const loadStats = async () => {
      loading.value = true;
      error.value = '';
      
      try {
        const response = await axios.get('/api/stats');
        eventStats.value = response.data.eventStats || [];
      } catch (err) {
        console.error('Error loading stats:', err);
        error.value = 'Failed to load statistics. Please try again.';
      } finally {
        loading.value = false;
      }
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
      eventStats,
      loading,
      error,
      isChangePasswordOpen,
      grandTotal,
      getPercentage,
      showChangePassword,
      handleLogout,
    };
  },
};
</script>

<style scoped>
.stats {
  min-height: 100vh;
  background: #f5f5f5;
}

.container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 30px;
}

.nav-tabs {
  display: flex;
  gap: 10px;
  margin-bottom: 30px;
  border-bottom: 2px solid #e0e0e0;
  overflow-x: auto;
}

.nav-tab {
  padding: 12px 24px;
  text-decoration: none;
  color: #666;
  border-bottom: 3px solid transparent;
  margin-bottom: -2px;
  transition: all 0.2s;
  font-weight: 500;
  white-space: nowrap;
}

.nav-tab:hover { color: #667eea; }
.nav-tab.active { color: #667eea; border-bottom-color: #667eea; }

.loading {
  text-align: center;
  padding: 60px;
  color: #888;
  font-size: 1.1rem;
}

.error-message {
  text-align: center;
  padding: 40px;
  color: #c62828;
  background: #ffebee;
  border-radius: 12px;
}

.stats-content h2 {
  margin-bottom: 20px;
  color: #333;
}

.stats-section {
  background: white;
  border-radius: 12px;
  padding: 24px;
  margin-bottom: 24px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.06);
}

.stats-section h3 {
  margin: 0 0 16px 0;
  color: #333;
  font-size: 1.2rem;
}

.stats-section.grand-total {
  border: 2px solid #667eea;
}

.stats-table {
  width: 100%;
}

.stats-table-header,
.stats-table-row {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1fr 2fr;
  gap: 8px;
  padding: 10px 16px;
  align-items: center;
}

.stats-table-header {
  background: #f8f9fa;
  border-radius: 8px;
  font-weight: 600;
  color: #555;
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.stats-table-row {
  border-bottom: 1px solid #f0f0f0;
}

.stats-table-row:last-child {
  border-bottom: none;
}

.stats-table-row.total-row {
  background: #f0f2ff;
  border-radius: 8px;
  margin-top: 4px;
}

.stats-col {
  font-size: 0.95rem;
}

.stats-col.event-name {
  font-weight: 500;
}

.scanned-value {
  color: #4CAF50;
  font-weight: 600;
}

.progress {
  display: flex;
  align-items: center;
  gap: 10px;
}

.progress-bar {
  flex: 1;
  height: 8px;
  background: #e0e0e0;
  border-radius: 4px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(135deg, #667eea, #764ba2);
  border-radius: 4px;
  transition: width 0.3s ease;
}

.progress-fill.grand-total {
  background: linear-gradient(135deg, #4CAF50, #45a049);
}

.progress-text {
  font-size: 0.85rem;
  color: #666;
  min-width: 40px;
  text-align: right;
}

@media (max-width: 768px) {
  .container { padding: 15px; }
  
  .stats-table-header,
  .stats-table-row {
    grid-template-columns: 1.5fr 1fr 1fr 1fr 1.5fr;
    font-size: 0.85rem;
    padding: 8px 12px;
  }
}
</style>
