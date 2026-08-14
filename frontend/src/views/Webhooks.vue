<template>
  <div class="webhooks">
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

      <div class="page-content">
        <h1>📡 Webhook Logs</h1>
        <p class="page-description">View Shopify webhook activity and processing status</p>

        <!-- Statistics Cards -->
        <div class="stats-row">
          <div class="stat-card">
            <div class="stat-label">Total Webhooks</div>
            <div class="stat-value">{{ stats.total_webhooks || 0 }}</div>
          </div>
          <div class="stat-card success">
            <div class="stat-label">Processed</div>
            <div class="stat-value">{{ stats.processed_webhooks || 0 }}</div>
          </div>
          <div class="stat-card warning">
            <div class="stat-label">Unprocessed</div>
            <div class="stat-value">{{ stats.unprocessed_webhooks || 0 }}</div>
          </div>
          <div class="stat-card error">
            <div class="stat-label">With Errors</div>
            <div class="stat-value">{{ stats.webhooks_with_errors || 0 }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Tickets Affected</div>
            <div class="stat-value">{{ stats.total_tickets_created || 0 }}</div>
          </div>
        </div>

        <!-- Filters -->
        <div class="filters">
          <label>
            <input type="radio" v-model="filter" value="all" @change="fetchWebhooks" />
            All Webhooks
          </label>
          <label>
            <input type="radio" v-model="filter" value="processed" @change="fetchWebhooks" />
            Processed Only
          </label>
          <label>
            <input type="radio" v-model="filter" value="unprocessed" @change="fetchWebhooks" />
            Unprocessed Only
          </label>
        </div>

        <!-- Loading State -->
        <div v-if="loading" class="loading">Loading webhook logs...</div>

        <!-- Error State -->
        <div v-else-if="error" class="error-message">{{ error }}</div>

        <!-- Webhooks Table -->
        <div v-else class="card">
          <div v-if="webhooks.length === 0" class="no-webhooks">
            No webhook logs found
          </div>
          <table v-else class="webhooks-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Order ID</th>
                <th>Tickets Affected</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="webhook in webhooks" :key="webhook.id">
                <td>{{ formatDate(webhook.created_at) }}</td>
                <td>
                  <span class="webhook-type-badge" :class="webhook.webhook_type || 'order_create'">
                    {{ formatWebhookType(webhook.webhook_type) }}
                  </span>
                </td>
                <td>{{ webhook.shopify_order_id || '-' }}</td>
                <td>
                  <span class="ticket-count" :class="{ zero: webhook.tickets_created === 0 }">
                    {{ webhook.tickets_created || 0 }}
                  </span>
                </td>
                <td>
                  <span class="status-badge" :class="getStatusClass(webhook)">
                    {{ getStatusText(webhook) }}
                  </span>
                </td>
                <td>
                  <div class="action-buttons">
                    <button @click="viewDetails(webhook)" class="btn-view">
                      View Details
                    </button>
                    <button 
                      v-if="canRetry(webhook)" 
                      @click="retryWebhook(webhook)" 
                      class="btn-retry"
                      :disabled="webhook.retrying"
                    >
                      {{ webhook.retrying ? 'Retrying...' : '🔄 Retry' }}
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Details Modal -->
    <div v-if="selectedWebhook" class="modal-overlay" @click="closeModal">
      <div class="modal-content" @click.stop>
        <div class="modal-header">
          <h2>Webhook Details</h2>
          <div class="modal-header-actions">
            <button @click="closeModal" class="btn-close">×</button>
          </div>
        </div>
        <div class="modal-body">
          <div class="detail-row">
            <strong>Webhook ID:</strong>
            <span>{{ selectedWebhook.id }}</span>
          </div>
          <div class="detail-row">
            <strong>Received:</strong>
            <span>{{ formatDateFull(selectedWebhook.created_at) }}</span>
          </div>
          <div class="detail-row">
            <strong>Webhook Type:</strong>
            <span class="webhook-type-badge" :class="selectedWebhook.webhook_type || 'order_create'">
              {{ formatWebhookType(selectedWebhook.webhook_type) }}
            </span>
          </div>
          <div class="detail-row">
            <strong>Shopify Order ID:</strong>
            <span>{{ selectedWebhook.shopify_order_id || '-' }}</span>
          </div>
          <div class="detail-row">
            <strong>Status:</strong>
            <span class="status-badge" :class="getStatusClass(selectedWebhook)">
              {{ getStatusText(selectedWebhook) }}
            </span>
          </div>
          <div class="detail-row">
            <strong>Tickets Created:</strong>
            <span>{{ selectedWebhook.tickets_created || 0 }}</span>
          </div>
          <div v-if="selectedWebhook.processed_at" class="detail-row">
            <strong>Processed At:</strong>
            <span>{{ formatDateFull(selectedWebhook.processed_at) }}</span>
          </div>
          <div v-if="selectedWebhook.error_message" class="detail-row error">
            <strong>Error Message:</strong>
            <span>{{ selectedWebhook.error_message }}</span>
          </div>
          
          <!-- Manual Retry Section -->
          <div v-if="showRetrySection(selectedWebhook)" class="retry-section">
            <strong>Manual Retry Options:</strong>
            <div class="retry-controls">
              <div class="webhook-type-selector">
                <label for="webhook-type-select">Process as webhook type:</label>
                <select 
                  id="webhook-type-select" 
                  v-model="selectedWebhookType" 
                  class="webhook-type-dropdown"
                >
                  <option value="">{{ formatWebhookType(selectedWebhook.webhook_type) }} (Original)</option>
                  <option 
                    v-for="type in availableWebhookTypes.filter(t => t.value !== selectedWebhook.webhook_type)" 
                    :key="type.value" 
                    :value="type.value"
                  >
                    {{ type.label }}
                  </option>
                </select>
              </div>
              <button 
                @click="retryWebhookFromModal" 
                class="btn-retry-with-type"
                :disabled="selectedWebhook.retrying"
              >
                {{ selectedWebhook.retrying ? 'Retrying...' : (
                  selectedWebhookType ? 
                  `🔄 Retry as ${availableWebhookTypes.find(t => t.value === selectedWebhookType)?.label}` : 
                  '🔄 Retry as Original Type'
                ) }}
              </button>
            </div>
            <div class="retry-help">
              <small>
                💡 <strong>Tip:</strong> You can process this webhook data as a different type. 
                For example, if an order webhook failed, you could retry it as a cancellation to invalidate the tickets.
                <br><br>
                <strong>Current behavior:</strong> {{ getWebhookDescription(selectedWebhook.webhook_type) }}
                <span v-if="selectedWebhookType">
                  <br><strong>Selected behavior:</strong> {{ getWebhookDescription(selectedWebhookType) }}
                </span>
                <br><br>
                <span v-if="selectedWebhook.processed && !selectedWebhook.error_message" class="warning-text">
                  ⚠️ <strong>Warning:</strong> This webhook was already processed successfully. 
                  Retrying will re-run the action, which may create duplicate tickets or change existing ticket statuses.
                </span>
              </small>
            </div>
          </div>
          
          <div v-if="webhookDetails" class="detail-section">
            <strong>Raw Webhook Data:</strong>
            <pre class="json-display">{{ formatJSON(webhookDetails.webhook_data) }}</pre>
          </div>
        </div>
      </div>
    </div>
    
    <!-- Notification Toast -->
    <div v-if="notification.show" class="notification-toast" :class="notification.type">
      {{ notification.message }}
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
  name: 'Webhooks',
  components: {
    ChangePasswordModal,
    PageHeader,
  },
  setup() {
    const router = useRouter();
    const authStore = useAuthStore();
    const isChangePasswordOpen = ref(false);

    const webhooks = ref([]);
    const stats = ref({});
    const loading = ref(false);
    const error = ref('');
    const filter = ref('all');
    const selectedWebhook = ref(null);
    const webhookDetails = ref(null);
    const retryingWebhooks = ref(new Set());
    const notification = ref({ show: false, message: '', type: 'success' });
    const selectedWebhookType = ref('');
    
    // Available webhook types for manual selection
    const availableWebhookTypes = ref([
      { value: 'order_create', label: '📦 Order Created' },
      { value: 'refund', label: '↩️ Refund' },
      { value: 'cancel', label: '✖️ Cancelled' },
      { value: 'chargeback', label: '⚠️ Chargeback' }
    ]);

    const fetchStats = async () => {
      try {
        const response = await axios.get('/api/webhooks/stats/summary');
        stats.value = response.data;
      } catch (err) {
        console.error('Error fetching webhook stats:', err);
      }
    };

    const fetchWebhooks = async () => {
      loading.value = true;
      error.value = '';
      
      try {
        const params = {};
        if (filter.value === 'processed') {
          params.processed = 'true';
        } else if (filter.value === 'unprocessed') {
          params.processed = 'false';
        }
        
        const response = await axios.get('/api/webhooks', { params });
        webhooks.value = response.data.logs;
      } catch (err) {
        console.error('Error fetching webhooks:', err);
        error.value = 'Failed to load webhook logs';
      } finally {
        loading.value = false;
      }
    };

    const viewDetails = async (webhook) => {
      selectedWebhook.value = webhook;
      selectedWebhookType.value = ''; // Reset webhook type selection when opening modal
      
      // Fetch full webhook details including JSON data
      try {
        const response = await axios.get(`/api/webhooks/${webhook.id}`);
        webhookDetails.value = response.data;
      } catch (err) {
        console.error('Error fetching webhook details:', err);
      }
    };

    const showNotification = (message, type = 'success') => {
      notification.value = { show: true, message, type };
      setTimeout(() => {
        notification.value.show = false;
      }, 4000);
    };
    
    const retryWebhook = async (webhook, overrideType = null) => {
      if (retryingWebhooks.value.has(webhook.id)) return;
      
      try {
        // Mark as retrying
        webhook.retrying = true;
        retryingWebhooks.value.add(webhook.id);
        
        const requestBody = {};
        if (overrideType) {
          requestBody.webhook_type = overrideType;
        }
        
        const response = await axios.post(`/api/webhooks/${webhook.id}/retry`, requestBody);
        
        console.log('Retry response:', response.data);
        
        // Show success message with type information
        const typeInfo = response.data.type_overridden ? 
          ` (processed as ${formatWebhookType(response.data.webhook_type)})` : '';
        showNotification(`✅ ${response.data.message}${typeInfo}`, 'success');
        
        // Refresh the webhooks list and stats
        await Promise.all([fetchWebhooks(), fetchStats()]);
        
      } catch (err) {
        console.error('Error retrying webhook:', err);
        const errorMsg = err.response?.data?.error || 'Failed to retry webhook';
        showNotification(`❌ Retry failed: ${errorMsg}`, 'error');
      } finally {
        webhook.retrying = false;
        retryingWebhooks.value.delete(webhook.id);
      }
    };
    
    const canRetry = (webhook) => {
      // Can retry if webhook failed, is unprocessed, or we want to show manual override options
      return !webhook.processed || webhook.error_message;
    };
    
    const showRetrySection = (webhook) => {
      // Always show the retry section in the modal for manual override capability
      return true;
    };
    
    const retryWebhookFromModal = async () => {
      if (selectedWebhook.value) {
        await retryWebhook(selectedWebhook.value, selectedWebhookType.value || null);
        // Refresh the modal details after retry
        if (selectedWebhook.value.processed || selectedWebhookType.value) {
          try {
            const response = await axios.get(`/api/webhooks/${selectedWebhook.value.id}`);
            webhookDetails.value = response.data;
            // Update the selected webhook data
            Object.assign(selectedWebhook.value, response.data);
          } catch (err) {
            console.error('Error refreshing webhook details:', err);
          }
        }
      }
    };
    
    const closeModal = () => {
      selectedWebhook.value = null;
      webhookDetails.value = null;
      selectedWebhookType.value = ''; // Reset webhook type selection
    };

    const getCustomerName = (webhook) => {
      // Try to extract customer name from webhook data (stored in the logs list endpoint doesn't include full data)
      // We'll need to show "-" here and display it in the details modal
      return '-';
    };

    const formatDate = (date) => {
      if (!date) return '-';
      return new Date(date).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
    };

    const formatDateFull = (date) => {
      if (!date) return '-';
      return new Date(date).toLocaleString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      });
    };

    const getStatusClass = (webhook) => {
      if (webhook.error_message) return 'error';
      if (webhook.processed) return 'success';
      return 'pending';
    };

    const getStatusText = (webhook) => {
      if (webhook.error_message) return 'Error';
      if (webhook.processed) return 'Success';
      return 'Pending';
    };

    const formatWebhookType = (type) => {
      const types = {
        'order_create': '📦 Order Created',
        'refund': '↩️ Refund',
        'cancel': '✖️ Cancelled',
        'chargeback': '⚠️ Chargeback'
      };
      return types[type] || '📦 Order';
    };

    const getWebhookDescription = (type) => {
      const descriptions = {
        'order_create': 'Creates new tickets from order data',
        'refund': 'Marks associated tickets as refunded (invalid)',
        'cancel': 'Marks associated tickets as cancelled (invalid)', 
        'chargeback': 'Marks associated tickets as chargeback (invalid)'
      };
      return descriptions[type] || 'Unknown action';
    };

    const formatJSON = (data) => {
      if (typeof data === 'string') {
        try {
          return JSON.stringify(JSON.parse(data), null, 2);
        } catch {
          return data;
        }
      }
      return JSON.stringify(data, null, 2);
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
      
      // Redirect if not superadmin
      if (authStore.user?.role !== 'superadmin') {
        router.push('/');
        return;
      }
      
      fetchStats();
      fetchWebhooks();
    });

    return {
      authStore,
      webhooks,
      stats,
      loading,
      error,
      filter,
      selectedWebhook,
      webhookDetails,
      isChangePasswordOpen,
      notification,
      selectedWebhookType,
      availableWebhookTypes,
      showNotification,
      fetchWebhooks,
      viewDetails,
      closeModal,
      retryWebhook,
      retryWebhookFromModal,
      canRetry,
      showRetrySection,
      getCustomerName,
      formatDate,
      formatDateFull,
      getStatusClass,
      getStatusText,
      formatWebhookType,
      getWebhookDescription,
      formatJSON,
      showChangePassword,
      handleLogout,
    };
  },
};
</script>

<style scoped>
.webhooks {
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

.page-content {
  max-width: 1200px;
}

.page-content h1 {
  font-size: 2rem;
  color: #333;
  margin-bottom: 0.5rem;
}

.page-description {
  color: #666;
  font-size: 1.1rem;
  margin-bottom: 2rem;
}

/* Statistics Row */
.stats-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 1rem;
  margin-bottom: 2rem;
}

.stat-card {
  background: white;
  padding: 1.5rem;
  border-radius: 8px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  text-align: center;
}

.stat-card.success {
  border-left: 4px solid #28a745;
}

.stat-card.warning {
  border-left: 4px solid #ffc107;
}

.stat-card.error {
  border-left: 4px solid #dc3545;
}

.stat-label {
  font-size: 0.875rem;
  color: #666;
  margin-bottom: 0.5rem;
}

.stat-value {
  font-size: 2rem;
  font-weight: 700;
  color: #333;
}

/* Filters */
.filters {
  display: flex;
  gap: 2rem;
  margin-bottom: 1.5rem;
  padding: 1rem;
  background: white;
  border-radius: 8px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.filters label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  font-weight: 500;
  color: #555;
}

.filters input[type="radio"] {
  cursor: pointer;
}

/* Card */
.card {
  background: white;
  padding: 2rem;
  border-radius: 12px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

/* Table */
.webhooks-table {
  width: 100%;
  border-collapse: collapse;
}

.webhooks-table th,
.webhooks-table td {
  padding: 1rem;
  text-align: left;
  border-bottom: 1px solid #e0e0e0;
}

.webhooks-table th {
  background: #f5f5f5;
  font-weight: 600;
  color: #333;
  font-size: 0.875rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.webhooks-table tr:hover {
  background: #f9f9f9;
}

.ticket-count {
  display: inline-block;
  padding: 0.25rem 0.75rem;
  background: #28a745;
  color: white;
  border-radius: 12px;
  font-weight: 600;
  font-size: 0.875rem;
}

.ticket-count.zero {
  background: #999;
}

.status-badge {
  display: inline-block;
  padding: 0.25rem 0.75rem;
  border-radius: 12px;
  font-size: 0.875rem;
  font-weight: 600;
}

.status-badge.success {
  background: #d4edda;
  color: #155724;
}

.status-badge.error {
  background: #f8d7da;
  color: #721c24;
}

.status-badge.pending {
  background: #fff3cd;
  color: #856404;
}

.webhook-type-badge {
  display: inline-block;
  padding: 0.25rem 0.75rem;
  border-radius: 12px;
  font-size: 0.875rem;
  font-weight: 600;
}

.webhook-type-badge.order_create {
  background: #d4edda;
  color: #155724;
}

.webhook-type-badge.refund {
  background: #fff3cd;
  color: #856404;
}

.webhook-type-badge.cancel {
  background: #e8e8e8;
  color: #424242;
}

.webhook-type-badge.chargeback {
  background: #f8d7da;
  color: #721c24;
}

.btn-view {
  background: #667eea;
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.875rem;
  transition: background 0.2s;
  margin-right: 0.5rem;
}

.btn-view:hover {
  background: #5568d3;
}

.btn-retry {
  background: #28a745;
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.875rem;
  transition: background 0.2s;
}

.btn-retry:hover:not(:disabled) {
  background: #218838;
}

.btn-retry:disabled {
  background: #6c757d;
  cursor: not-allowed;
  opacity: 0.7;
}

.action-buttons {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

/* Notification Toast */
.notification-toast {
  position: fixed;
  top: 2rem;
  right: 2rem;
  padding: 1rem 1.5rem;
  border-radius: 8px;
  font-weight: 600;
  z-index: 2000;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  transition: all 0.3s ease;
  max-width: 400px;
  word-wrap: break-word;
}

.notification-toast.success {
  background: #d4edda;
  color: #155724;
  border: 1px solid #c3e6cb;
}

.notification-toast.error {
  background: #f8d7da;
  color: #721c24;
  border: 1px solid #f5c6cb;
}

.loading,
.error-message,
.no-webhooks {
  padding: 2rem;
  text-align: center;
  color: #666;
}

.error-message {
  color: #dc3545;
}

/* Modal */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 2rem;
}

.modal-content {
  background: white;
  border-radius: 12px;
  max-width: 800px;
  width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 8px 24px rgba(0,0,0,0.2);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1.5rem;
  border-bottom: 1px solid #e0e0e0;
}

.modal-header h2 {
  margin: 0;
  font-size: 1.5rem;
  color: #333;
}

.modal-header-actions {
  display: flex;
  align-items: center;
}

.btn-close {
  background: none;
  border: none;
  font-size: 2rem;
  color: #999;
  cursor: pointer;
  line-height: 1;
  padding: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: background 0.2s;
}

.btn-close:hover {
  background: #f5f5f5;
  color: #333;
}

.modal-body {
  padding: 1.5rem;
}

.detail-row {
  display: flex;
  gap: 1rem;
  padding: 0.75rem 0;
  border-bottom: 1px solid #f0f0f0;
}

.detail-row strong {
  min-width: 150px;
  color: #555;
}

.detail-row.error {
  background: #fff5f5;
  padding: 1rem;
  border-radius: 8px;
  border: 1px solid #f8d7da;
}

.detail-row.error span {
  color: #721c24;
}

.detail-section {
  margin-top: 1.5rem;
}

.detail-section strong {
  display: block;
  margin-bottom: 0.5rem;
  color: #555;
}

/* Retry Section Styles */
.retry-section {
  margin-top: 1.5rem;
  padding: 1.5rem;
  background: #f8f9fa;
  border-radius: 8px;
  border: 1px solid #e9ecef;
}

.retry-section strong {
  display: block;
  margin-bottom: 1rem;
  color: #333;
  font-size: 1rem;
}

.retry-controls {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-bottom: 1rem;
}

.webhook-type-selector {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.webhook-type-selector label {
  font-weight: 600;
  color: #555;
  font-size: 0.875rem;
}

.webhook-type-dropdown {
  padding: 0.75rem;
  border: 1px solid #ddd;
  border-radius: 6px;
  background: white;
  font-size: 0.875rem;
  color: #333;
  cursor: pointer;
  transition: border-color 0.2s;
}

.webhook-type-dropdown:focus {
  outline: none;
  border-color: #667eea;
  box-shadow: 0 0 0 2px rgba(102, 126, 234, 0.1);
}

.btn-retry-with-type {
  background: #17a2b8;
  color: white;
  border: none;
  padding: 0.75rem 1.5rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.875rem;
  font-weight: 600;
  transition: background 0.2s;
  align-self: flex-start;
}

.btn-retry-with-type:hover:not(:disabled) {
  background: #138496;
}

.btn-retry-with-type:disabled {
  background: #6c757d;
  cursor: not-allowed;
  opacity: 0.7;
}

.retry-help {
  padding: 1rem;
  background: #e3f2fd;
  border-radius: 6px;
  border-left: 4px solid #2196f3;
}

.retry-help small {
  color: #1976d2;
  line-height: 1.4;
}

.retry-help .warning-text {
  color: #d84315 !important;
  font-weight: 600;
}

.json-display {
  background: #f5f5f5;
  padding: 1rem;
  border-radius: 8px;
  overflow-x: auto;
  font-size: 0.875rem;
  line-height: 1.5;
  border: 1px solid #e0e0e0;
  max-height: 400px;
  overflow-y: auto;
}

@media (max-width: 768px) {
  .stats-row {
    grid-template-columns: 1fr;
  }

  .filters {
    flex-direction: column;
    gap: 1rem;
  }

  .nav-tabs {
    flex-wrap: wrap;
  }

  .nav-tab {
    padding: 10px 16px;
    font-size: 14px;
  }

  .webhooks-table {
    font-size: 0.875rem;
    overflow-x: auto;
    display: block;
    white-space: nowrap;
  }

  .webhooks-table th,
  .webhooks-table td {
    padding: 0.5rem;
    min-width: 120px;
  }
  
  .action-buttons {
    flex-direction: column;
    min-width: 140px;
  }
  
  .btn-view, .btn-retry {
    font-size: 0.75rem;
    padding: 0.4rem 0.8rem;
    margin: 0;
    width: 100%;
  }
  
  .modal-header-actions {
    flex-direction: column;
    gap: 0.5rem;
  }
  
  .btn-retry-modal {
    font-size: 0.75rem;
    padding: 0.5rem 1rem;
  }
  
  .notification-toast {
    top: 1rem;
    right: 1rem;
    left: 1rem;
    max-width: none;
    font-size: 0.875rem;
  }
  
  .retry-controls {
    gap: 0.75rem;
  }
  
  .btn-retry-with-type {
    font-size: 0.75rem;
    padding: 0.6rem 1rem;
    align-self: stretch;
  }
  
  .retry-help {
    padding: 0.75rem;
  }
}
</style>
