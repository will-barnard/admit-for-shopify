<template>
  <div class="settings">
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

      <div class="settings-card">
        <h2>General Information</h2>
        
        <form @submit.prevent="saveSettings">
          <div class="form-group">
            <label for="orgName">Organization Name</label>
            <input
              type="text"
              id="orgName"
              v-model="settings.org_name"
              placeholder="Enter organization name"
              required
            />
          </div>

          <div class="form-group">
            <label>Convention Logo</label>
            <div class="logo-upload-area">
              <div v-if="settings.logo_url || logoPreview" class="logo-preview">
                <img :src="logoPreview || getLogoUrl(settings.logo_url)" alt="Organization Logo" />
              </div>
              <div v-else class="logo-placeholder">
                <p>📷 No logo uploaded</p>
              </div>
              
              <div class="logo-buttons">
                <input
                  type="file"
                  ref="logoInput"
                  @change="handleLogoSelect"
                  accept="image/*"
                  style="display: none"
                />
                <button type="button" @click="$refs.logoInput.click()" class="btn-upload">
                  {{ settings.logo_url ? 'Change Logo' : 'Upload Logo' }}
                </button>
                <button 
                  v-if="settings.logo_url || logoPreview" 
                  type="button" 
                  @click="removeLogo" 
                  class="btn-remove-logo"
                >
                  Remove Logo
                </button>
              </div>
              
              <p class="hint">Recommended: PNG or JPG, max 5MB</p>
            </div>
          </div>

          <div class="form-actions">
            <button type="submit" class="btn-save" :disabled="saving">
              {{ saving ? 'Saving...' : 'Save Changes' }}
            </button>
          </div>
        </form>

        <div v-if="message" :class="['message', messageType]">
          {{ message }}
        </div>
      </div>


      
      <div class="settings-card">
        <h2>Email Settings</h2>
        
        <form @submit.prevent="saveSettings">
          <div class="form-group">
            <label class="checkbox-label">
              <input
                type="checkbox"
                v-model="settings.auto_send_emails"
              />
              <span>Automatically Send Ticket Emails</span>
            </label>
            <p class="hint">When enabled, ticket emails will be sent immediately upon creation</p>
          </div>

          <div class="form-actions">
            <button type="submit" class="btn-save" :disabled="saving">
              {{ saving ? 'Saving...' : 'Save Email Settings' }}
            </button>
          </div>
        </form>

        <div class="batch-send-section">
          <h3>Batch Send Unsent Emails</h3>
          <p class="hint">Send emails to all ticket holders who haven't received their tickets yet. Emails are sent at a rate of 10 per minute to avoid rate limiting. Maximum 85 emails per batch to reserve capacity for new orders.</p>
          <p class="hint" style="color: #2196F3; font-weight: 500;">
            💡 If orders come in when the daily limit is reached, tickets are created but emails are marked as unsent. Run batch send the next day to automatically send them.
          </p>
          <div v-if="dailyQuota" class="quota-display" :class="{ 'quota-warning': dailyQuota.remaining < 20, 'quota-depleted': dailyQuota.remaining === 0 }">
            <strong>Daily Email Quota:</strong> {{ dailyQuota.remaining }} remaining ({{ dailyQuota.sentToday }}/{{ dailyQuota.dailyLimit }} sent today)
          </div>
          
          <div class="form-group">
            <label for="batchEventFilter">Filter by Event</label>
            <select id="batchEventFilter" v-model="batchEventFilter">
              <option value="all">All Events</option>
              <option v-for="event in events" :key="event.id" :value="event.id">{{ event.name }}</option>
            </select>
          </div>
          
          <button 
            @click="batchSendEmails" 
            class="btn-batch-send"
            :disabled="batchSending || (dailyQuota && dailyQuota.remaining === 0)"
          >
            {{ batchSending ? `Sending... (${batchProgress.sent}/${batchProgress.total})` : (dailyQuota && dailyQuota.remaining === 0 ? 'Daily Limit Reached' : 'Send All Unsent Emails') }}
          </button>
          
          <div v-if="batchMessage" :class="['batch-message', batchMessageType]">
            {{ batchMessage }}
          </div>
        </div>
      </div>
      
      <div class="settings-card">
        <h2>Timezone</h2>
        
        <form @submit.prevent="saveSettings">
          <div class="form-group">
            <label for="timezone">Time Zone</label>
            <select
              id="timezone"
              v-model="settings.timezone"
              required
            >
              <option value="America/New_York">Eastern Time (ET)</option>
              <option value="America/Chicago">Central Time (CT)</option>
              <option value="America/Denver">Mountain Time (MT)</option>
              <option value="America/Phoenix">Arizona Time (MST - no DST)</option>
              <option value="America/Los_Angeles">Pacific Time (PT)</option>
              <option value="America/Anchorage">Alaska Time (AKT)</option>
              <option value="Pacific/Honolulu">Hawaii Time (HST)</option>
              <option value="America/Toronto">Toronto (ET)</option>
              <option value="America/Vancouver">Vancouver (PT)</option>
              <option value="Europe/London">London (GMT/BST)</option>
              <option value="Europe/Paris">Paris (CET/CEST)</option>
              <option value="Asia/Tokyo">Tokyo (JST)</option>
              <option value="Australia/Sydney">Sydney (AEDT/AEST)</option>
            </select>
            <p class="hint">Set the timezone for accurate ticket validation</p>
          </div>

          <div class="form-actions">
            <button type="submit" class="btn-save" :disabled="saving">
              {{ saving ? 'Saving...' : 'Save Changes' }}
            </button>
          </div>
        </form>
      </div>
      
      <div v-if="authStore.user?.role === 'superadmin'" class="settings-card superadmin-section">
        <h2>🔒 SuperAdmin Controls</h2>
        <p class="hint danger-hint">⚠️ These actions are irreversible and should be used with extreme caution</p>
        
        <div class="superadmin-actions">
          <div class="action-item lockdown-item">
            <div class="action-info">
              <h3>🔐 Lockdown Mode</h3>
              <p>{{ lockdownEnabled ? 'Database is currently LOCKED. All ticket creation and scanning is disabled.' : 'Enable lockdown mode to freeze all ticket creation and scanning operations. Database becomes read-only.' }}</p>
            </div>
            <div class="lockdown-toggle">
              <label class="toggle-switch">
                <input 
                  type="checkbox" 
                  v-model="lockdownEnabled" 
                  @change="toggleLockdown"
                  :disabled="togglingLockdown"
                />
                <span class="slider"></span>
              </label>
              <span class="toggle-status" :class="{ active: lockdownEnabled }">
                {{ lockdownEnabled ? '🔒 LOCKED' : '🔓 Unlocked' }}
              </span>
            </div>
          </div>
          
          <div class="action-item">
            <div class="action-info">
              <h3>Reset Database</h3>
              <p>Delete all tickets, scans, and supplies from the database. User accounts will NOT be affected.</p>
            </div>
            <button @click="confirmResetDatabase" class="btn-danger" :disabled="resetting || lockdownEnabled">
              {{ resetting ? 'Resetting...' : 'Reset Database' }}
            </button>
          </div>
        </div>
        
        <div v-if="resetMessage" :class="['action-message', resetMessageType]">
          {{ resetMessage }}
        </div>
        <div v-if="lockdownMessage" :class="['action-message', lockdownMessageType]">
          {{ lockdownMessage }}
        </div>
      </div>
      
      <div v-if="authStore.user?.role === 'superadmin'" class="settings-card migration-section">
        <h2>🔄 Database Migration</h2>
        <p class="hint">Transfer ticket data between instances of this application</p>
        
        <!-- Receive Mode Toggle -->
        <div class="migration-subsection">
          <h3>Receive Mode</h3>
          <p class="hint">Enable this mode to allow another instance to send data to this one</p>
          
          <div class="receive-mode-toggle">
            <label class="toggle-label">
              <input 
                type="checkbox" 
                v-model="receiveModeEnabled" 
                @change="toggleReceiveMode"
                :disabled="togglingReceiveMode"
              />
              <span>{{ receiveModeEnabled ? 'Receive Mode Enabled' : 'Receive Mode Disabled' }}</span>
            </label>
          </div>
          
          <div v-if="receiveModeEnabled && receiveModeSecret" class="secret-display">
            <label>Secret Key (required for sending):</label>
            <div class="secret-key-box">
              <code>{{ receiveModeSecret }}</code>
              <button @click="copySecret" class="btn-copy">
                <font-awesome-icon icon="copy" />
                Copy
              </button>
            </div>
            <p class="hint">⚠️ Keep this secret key secure. Anyone with it can send data to this instance.</p>
          </div>
        </div>
        
        <!-- Export/Send Database -->
        <div class="migration-subsection">
          <h3>Export Database to Another Instance</h3>
          <p class="hint">Send all tickets, scans, and supplies to another instance in receive mode</p>
          
          <div class="form-group">
            <label>Target Instance URL</label>
            <input 
              type="text" 
              v-model="exportTargetUrl" 
              placeholder="https://example.com"
              :disabled="exporting"
            />
            <p class="hint">Enter the root URL of the target instance (e.g., http://192.168.1.100:8080)</p>
          </div>
          
          <div class="form-group">
            <label>Target Instance Secret Key</label>
            <input 
              type="text" 
              v-model="exportSecretKey" 
              placeholder="Enter the secret key from the target instance"
              :disabled="exporting"
            />
          </div>
          
          <button @click="confirmExportDatabase" class="btn-export-db" :disabled="exporting || !exportTargetUrl || !exportSecretKey">
            {{ exporting ? 'Sending...' : 'Send Database to Target' }}
          </button>
        </div>
        
        <div v-if="migrationMessage" :class="['action-message', migrationMessageType]">
          {{ migrationMessage }}
        </div>
      </div>
      
      <div class="settings-card">
        <h2>Export Ticket Data</h2>
        <p class="hint">Download ticket data as CSV</p>
        
        <div class="export-buttons">
          <button @click="downloadAllTicketsCSV" class="btn-export">
            <font-awesome-icon icon="ticket" />
            Download All Tickets CSV
          </button>
          <button @click="downloadNoEmailTickets" class="btn-export">
            <font-awesome-icon icon="envelope-open" />
            Download No-Email Tickets CSV
          </button>
        </div>
      </div>
      
      <div class="settings-card">
        <h2>Post-Event Report</h2>
        <p class="hint">Download a comprehensive report of all tickets with check-in times</p>
        
        <div class="export-buttons">
          <button @click="downloadPostEventReport" class="btn-export btn-report">
            <font-awesome-icon icon="file-download" />
            Download Full Report CSV
          </button>
        </div>
      </div>
      
    </div>
  </div>
</template>

<script>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import axios from 'axios';
import ChangePasswordModal from '@/components/ChangePasswordModal.vue';
import PageHeader from '@/components/PageHeader.vue';

export default {
  name: 'Settings',
  components: {
    ChangePasswordModal,
    PageHeader,
  },
  setup() {
    const router = useRouter();
    const authStore = useAuthStore();
    const isChangePasswordOpen = ref(false);

    const settings = ref({
      org_name: '',
      logo_url: null,
      auto_send_emails: true,
      timezone: 'America/Chicago'
    });
    const events = ref([]);
    const logoPreview = ref(null);
    const logoInput = ref(null);
    const logoFile = ref(null);
    const saving = ref(false);
    const message = ref('');
    const messageType = ref('');
    const batchSending = ref(false);
    const batchMessage = ref('');
    const batchMessageType = ref('');
    const batchProgress = ref({ sent: 0, total: 0 });
    const batchEventFilter = ref('all');
    const dailyQuota = ref(null);
    const resetting = ref(false);
    const resetMessage = ref('');
    const resetMessageType = ref('');
    
    // Lockdown mode refs
    const lockdownEnabled = ref(false);
    const togglingLockdown = ref(false);
    const lockdownMessage = ref('');
    const lockdownMessageType = ref('');
    
    // Migration refs
    const receiveModeEnabled = ref(false);
    const receiveModeSecret = ref('');
    const togglingReceiveMode = ref(false);
    const exportTargetUrl = ref('');
    const exportSecretKey = ref('');
    const exporting = ref(false);
    const migrationMessage = ref('');
    const migrationMessageType = ref('');

    const fetchSettings = async () => {
      try {
        const response = await axios.get('/api/settings');
        const data = response.data;
        
        settings.value = data;
        
        // Load receive mode settings
        receiveModeEnabled.value = data.receive_mode_enabled || false;
        receiveModeSecret.value = data.receive_mode_secret || '';
        
        // Load lockdown mode setting
        lockdownEnabled.value = data.lockdown_mode || false;
      } catch (error) {
        console.error('Error fetching settings:', error);
      }
    };

    const fetchEvents = async () => {
      try {
        const response = await axios.get('/api/events/list/active');
        events.value = response.data;
      } catch (error) {
        console.error('Error fetching events:', error);
      }
    };

    const handleLogoSelect = (event) => {
      const file = event.target.files[0];
      if (file) {
        logoFile.value = file;
        const reader = new FileReader();
        reader.onload = (e) => {
          logoPreview.value = e.target.result;
        };
        reader.readAsDataURL(file);
      }
    };

    const removeLogo = async () => {
      if (confirm('Are you sure you want to remove the logo?')) {
        try {
          await axios.delete('/api/settings/logo');
          settings.value.logo_url = null;
          logoPreview.value = null;
          logoFile.value = null;
          showMessage('Logo removed successfully', 'success');
        } catch (error) {
          console.error('Error removing logo:', error);
          showMessage('Failed to remove logo', 'error');
        }
      }
    };

    const saveSettings = async () => {
      saving.value = true;
      message.value = '';

      try {
        // Save all settings
        await axios.put('/api/settings', {
          org_name: settings.value.org_name,
          auto_send_emails: settings.value.auto_send_emails,
          timezone: settings.value.timezone
        });

        // Upload logo if selected
        if (logoFile.value) {
          const formData = new FormData();
          formData.append('logo', logoFile.value);
          
          const response = await axios.post('/api/settings/logo', formData, {
            headers: { 'Content-Type': 'multipart/form-data' }
          });
          
          settings.value.logo_url = response.data.logo_url;
          logoPreview.value = null;
          logoFile.value = null;
        }

        showMessage('Settings saved successfully!', 'success');
      } catch (error) {
        console.error('Error saving settings:', error);
        showMessage('Failed to save settings', 'error');
      } finally {
        saving.value = false;
      }
    };

    const showMessage = (text, type) => {
      message.value = text;
      messageType.value = type;
      setTimeout(() => {
        message.value = '';
      }, 3000);
    };

    const showBatchMessage = (text, type) => {
      batchMessage.value = text;
      batchMessageType.value = type;
      setTimeout(() => {
        batchMessage.value = '';
      }, 5000);
    };

    const loadDailyQuota = async () => {
      try {
        const response = await axios.get('/api/tickets/daily-email-quota');
        dailyQuota.value = response.data;
      } catch (error) {
        console.error('Error loading daily quota:', error);
      }
    };

    const batchSendEmails = async () => {
      if (dailyQuota.value && dailyQuota.value.remaining === 0) {
        alert('Daily email limit of 100 emails has been reached. Please try again tomorrow.');
        return;
      }
      
      const filterLabel = batchEventFilter.value === 'all' ? 'all ticket holders' : events.value.find(e => e.id === batchEventFilter.value)?.name || 'selected event';
      const batchLimit = Math.min(85, dailyQuota.value?.remaining || 85);
      const quotaWarning = dailyQuota.value ? ` (Limited to ${batchLimit} emails per batch, ${dailyQuota.value.remaining} remaining in today's quota)` : '';
      if (!confirm(`Send emails to ${filterLabel} who haven't received their tickets yet?${quotaWarning}\n\nThis may take several minutes.`)) {
        return;
      }

      batchSending.value = true;
      batchMessage.value = '';
      batchProgress.value = { sent: 0, total: 0 };

      try {
        const payload = {};
        if (batchEventFilter.value !== 'all') {
          payload.eventId = batchEventFilter.value;
        }
        const response = await axios.post('/api/tickets/batch-send-emails', payload);
        const result = response.data;
        
        batchProgress.value = {
          sent: result.sent,
          total: result.total
        };
        
        // Update daily quota
        if (result.dailyQuota) {
          dailyQuota.value = result.dailyQuota;
        }

        if (result.failed > 0) {
          showBatchMessage(
            `Batch send complete! Sent: ${result.sent}, Failed: ${result.failed}. ${dailyQuota.value.remaining} emails remaining today.`,
            'warning'
          );
        } else if (result.sent === 0) {
          showBatchMessage('No unsent emails found', 'info');
        } else {
          const quotaMsg = dailyQuota.value ? ` ${dailyQuota.value.remaining} emails remaining today.` : '';
          showBatchMessage(`Successfully sent ${result.sent} emails!${quotaMsg}`, 'success');
        }
      } catch (error) {
        console.error('Error batch sending emails:', error);
        if (error.response?.status === 429) {
          showBatchMessage(error.response.data.error || 'Daily email limit reached', 'error');
          // Reload quota to show updated numbers
          await loadDailyQuota();
        } else {
          showBatchMessage('Failed to send emails. Please try again.', 'error');
        }
      } finally {
        batchSending.value = false;
      }
    };

    const downloadAllTicketsCSV = async () => {
      try {
        const response = await axios.get('/api/tickets');
        const allTickets = response.data.tickets || response.data;
        
        if (allTickets.length === 0) {
          alert('No tickets found to export.');
          return;
        }

        let csvContent = 'Name,Email,Event,Status,Email Sent,Created,Scanned,Scanned On\n';
        allTickets.forEach(ticket => {
          const name = `"${(ticket.name || '').replace(/"/g, '""')}"`;
          const email = ticket.email || '';
          const eventName = `"${(ticket.event_name || '').replace(/"/g, '""')}"`;
          const status = ticket.status || 'valid';
          const emailSent = ticket.email_sent ? 'Yes' : 'No';
          const created = new Date(ticket.created_at).toLocaleDateString();
          const scanned = ticket.scans?.scanned ? 'Yes' : 'No';
          const scannedOn = ticket.scans?.scannedOn ? new Date(ticket.scans.scannedOn).toLocaleDateString() : '';
          csvContent += `${name},${email},${eventName},${status},${emailSent},${created},${scanned},"${scannedOn}"\n`;
        });

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        const timestamp = new Date().toISOString().split('T')[0];
        link.setAttribute('href', url);
        link.setAttribute('download', `all-tickets-${timestamp}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } catch (error) {
        console.error('Error downloading CSV:', error);
        alert('Failed to download CSV. Please try again.');
      }
    };

    const downloadNoEmailTickets = async () => {
      try {
        const response = await axios.get('/api/settings/export-no-email-tickets', {
          responseType: 'blob'
        });
        
        // Create a blob from the response
        const blob = new Blob([response.data], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', `no-email-tickets-${new Date().toISOString().split('T')[0]}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
      } catch (error) {
        console.error('Error downloading no-email tickets CSV:', error);
        if (error.response && error.response.status === 404) {
          alert('No tickets without email found.');
        } else {
          alert('Failed to download CSV. Please try again.');
        }
      }
    };

    const downloadPostEventReport = async () => {
      try {
        const response = await axios.get('/api/tickets');
        const allTickets = response.data.tickets || response.data;
        
        if (allTickets.length === 0) {
          alert('No tickets found to export.');
          return;
        }

        let csvContent = 'Name,Email,Event,Status,Email Sent,Created,Scanned,Scanned On\n';
        
        allTickets.forEach(ticket => {
          const name = `"${(ticket.name || '').replace(/"/g, '""')}"`;
          const email = ticket.email || '';
          const eventName = `"${(ticket.event_name || '').replace(/"/g, '""')}"`;
          const status = ticket.status || 'valid';
          const emailSent = ticket.email_sent ? 'Yes' : 'No';
          const created = new Date(ticket.created_at).toLocaleDateString();
          const scanned = ticket.scans?.scanned ? 'Yes' : 'No';
          const scannedOn = ticket.scans?.scannedOn 
            ? `"${new Date(ticket.scans.scannedOn).toLocaleString()}"` 
            : '""';
          
          csvContent += `${name},${email},${eventName},${status},${emailSent},${created},${scanned},${scannedOn}\n`;
        });

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        const timestamp = new Date().toISOString().split('T')[0];
        link.setAttribute('href', url);
        link.setAttribute('download', `post-event-report-${timestamp}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } catch (error) {
        console.error('Error downloading report:', error);
        alert('Failed to download report. Please try again.');
      }
    };

    const getLogoUrl = (logoUrl) => {
      if (!logoUrl) return '';
      // Logo is served through nginx proxy at /uploads
      return logoUrl;
    };

    const confirmResetDatabase = () => {
      const confirmed = confirm(
        '⚠️ WARNING: This will permanently delete ALL tickets, scans, and supplies from the database.\n\n' +
        'User accounts will NOT be affected.\n\n' +
        'This action CANNOT be undone.\n\n' +
        'Are you absolutely sure you want to reset the database?'
      );
      
      if (confirmed) {
        const doubleConfirm = confirm(
          '⚠️ FINAL CONFIRMATION\n\n' +
          'Please confirm one more time that you want to delete ALL ticket data.\n\n' +
          'Type YES in your mind and click OK to proceed.'
        );
        
        if (doubleConfirm) {
          resetDatabase();
        }
      }
    };

    const resetDatabase = async () => {
      resetting.value = true;
      resetMessage.value = '';
      
      try {
        const response = await axios.delete('/api/tickets/reset-database');
        resetMessage.value = `Database reset successful. Deleted ${response.data.deleted.tickets} tickets.`;
        resetMessageType.value = 'success';
        
        // Clear message after 10 seconds
        setTimeout(() => {
          resetMessage.value = '';
        }, 10000);
      } catch (error) {
        console.error('Error resetting database:', error);
        if (error.response?.status === 403) {
          resetMessage.value = 'Access denied. SuperAdmin privileges required.';
        } else {
          resetMessage.value = 'Failed to reset database. Please try again.';
        }
        resetMessageType.value = 'error';
      } finally {
        resetting.value = false;
      }
    };

    // Lockdown mode functions
    const toggleLockdown = async () => {
      togglingLockdown.value = true;
      lockdownMessage.value = '';
      
      try {
        const response = await axios.put('/api/settings/lockdown-mode', {
          enabled: lockdownEnabled.value
        });
        
        lockdownMessage.value = lockdownEnabled.value 
          ? '🔒 Lockdown mode ENABLED. All ticket creation and scanning is now disabled.'
          : '🔓 Lockdown mode disabled. Normal operations resumed.';
        lockdownMessageType.value = lockdownEnabled.value ? 'warning' : 'success';
        
        setTimeout(() => {
          lockdownMessage.value = '';
        }, 8000);
      } catch (error) {
        console.error('Error toggling lockdown mode:', error);
        lockdownMessage.value = error.response?.data?.error || 'Failed to toggle lockdown mode';
        lockdownMessageType.value = 'error';
        // Revert toggle
        lockdownEnabled.value = !lockdownEnabled.value;
      } finally {
        togglingLockdown.value = false;
      }
    };

    // Migration functions
    const toggleReceiveMode = async () => {
      togglingReceiveMode.value = true;
      migrationMessage.value = '';
      
      try {
        const response = await axios.put('/api/settings/receive-mode', {
          enabled: receiveModeEnabled.value
        });
        
        receiveModeSecret.value = response.data.receive_mode_secret || '';
        
        migrationMessage.value = receiveModeEnabled.value 
          ? 'Receive mode enabled. Share the secret key with the source instance.'
          : 'Receive mode disabled.';
        migrationMessageType.value = 'success';
        
        setTimeout(() => {
          migrationMessage.value = '';
        }, 10000);
      } catch (error) {
        console.error('Error toggling receive mode:', error);
        migrationMessage.value = error.response?.data?.error || 'Failed to toggle receive mode';
        migrationMessageType.value = 'error';
        // Revert toggle
        receiveModeEnabled.value = !receiveModeEnabled.value;
      } finally {
        togglingReceiveMode.value = false;
      }
    };
    
    const copySecret = () => {
      navigator.clipboard.writeText(receiveModeSecret.value);
      migrationMessage.value = 'Secret key copied to clipboard!';
      migrationMessageType.value = 'success';
      setTimeout(() => {
        migrationMessage.value = '';
      }, 3000);
    };
    
    const confirmExportDatabase = () => {
      const confirmed = confirm(
        '⚠️ EXPORT DATABASE WARNING\n\n' +
        `You are about to send all tickets, scans, and supplies to:\n${exportTargetUrl.value}\n\n` +
        'The target instance must be in receive mode.\n\n' +
        'This will transfer all your ticket data to the target instance.\n\n' +
        'Are you sure you want to proceed?'
      );
      
      if (confirmed) {
        exportDatabase();
      }
    };
    
    const exportDatabase = async () => {
      exporting.value = true;
      migrationMessage.value = '';
      
      try {
        const response = await axios.post('/api/migration/send', {
          targetUrl: exportTargetUrl.value,
          secret: exportSecretKey.value
        });
        
        migrationMessage.value = 
          `Migration successful! Sent ${response.data.sent.tickets} tickets, ` +
          `${response.data.sent.scans} scans, ${response.data.sent.supplies} supplies.`;
        migrationMessageType.value = 'success';
        
        // Clear form
        exportTargetUrl.value = '';
        exportSecretKey.value = '';
        
        setTimeout(() => {
          migrationMessage.value = '';
        }, 15000);
      } catch (error) {
        console.error('Error exporting database:', error);
        migrationMessage.value = error.response?.data?.error || 'Failed to export database';
        if (error.response?.data?.details) {
          migrationMessage.value += ': ' + error.response.data.details;
        }
        migrationMessageType.value = 'error';
      } finally {
        exporting.value = false;
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
      fetchSettings();
      fetchEvents();
      loadDailyQuota();
      
      // Refresh quota every 30 seconds when on this page
      const quotaInterval = setInterval(() => {
        loadDailyQuota();
      }, 30000);
      
      // Cleanup interval when component unmounts
      onBeforeUnmount(() => {
        clearInterval(quotaInterval);
      });
    });

    return {
      authStore,
      settings,
      logoPreview,
      logoInput,
      saving,
      message,
      messageType,
      batchSending,
      batchMessage,
      batchMessageType,
      batchProgress,
      batchEventFilter,
      events,
      dailyQuota,
      resetting,
      resetMessage,
      resetMessageType,
      lockdownEnabled,
      togglingLockdown,
      lockdownMessage,
      lockdownMessageType,
      receiveModeEnabled,
      receiveModeSecret,
      togglingReceiveMode,
      exportTargetUrl,
      exportSecretKey,
      exporting,
      migrationMessage,
      migrationMessageType,
      isChangePasswordOpen,
      handleLogoSelect,
      removeLogo,
      saveSettings,
      getLogoUrl,
      batchSendEmails,
      downloadAllTicketsCSV,
      downloadNoEmailTickets,
      downloadPostEventReport,
      confirmResetDatabase,
      toggleLockdown,
      toggleReceiveMode,
      copySecret,
      confirmExportDatabase,
      showChangePassword,
      handleLogout
    };
  }
};
</script>

<style scoped>
.settings {
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

.settings-card {
  background: white;
  border-radius: 12px;
  padding: 2rem;
  margin-bottom: 2rem;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
}

.settings-card h2 {
  margin-top: 0;
  margin-bottom: 1.5rem;
  color: #333;
  font-size: 1.5rem;
}

.form-group {
  margin-bottom: 1.5rem;
}

.form-group label {
  display: block;
  margin-bottom: 0.5rem;
  font-weight: 600;
  color: #555;
}

.form-group input[type="text"] {
  width: 100%;
  padding: 0.75rem;
  border: 2px solid #e0e0e0;
  border-radius: 8px;
  font-size: 1rem;
  transition: border-color 0.3s;
}

.form-group input[type="number"] {
  width: 100%;
  padding: 0.75rem;
  border: 2px solid #e0e0e0;
  border-radius: 8px;
  font-size: 1rem;
  transition: border-color 0.3s;
}

.form-group select {
  width: 100%;
  padding: 0.75rem;
  border: 2px solid #e0e0e0;
  border-radius: 8px;
  font-size: 1rem;
  transition: border-color 0.3s;
  background: white;
  cursor: pointer;
}

.form-group input[type="text"]:focus,
.form-group input[type="number"]:focus,
.form-group select:focus {
  outline: none;
  border-color: #667eea;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  font-weight: 600;
  color: #555;
}

.checkbox-label input[type="checkbox"] {
  width: 20px;
  height: 20px;
  cursor: pointer;
}

.logo-upload-area {
  border: 2px dashed #e0e0e0;
  border-radius: 8px;
  padding: 1.5rem;
  text-align: center;
}

.logo-preview {
  display: flex;
  justify-content: center;
  align-items: center;
  margin-bottom: 1.5rem;
}

.logo-preview img {
  max-width: 100%;
  max-height: 200px;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  object-fit: contain;
}

.logo-buttons {
  display: flex;
  gap: 10px;
  justify-content: center;
  margin-top: 1rem;
  flex-wrap: wrap;
}

.btn-remove-logo {
  background: #ff4444;
  color: white;
  border: none;
  padding: 0.75rem 1.5rem;
  border-radius: 8px;
  cursor: pointer;
  font-size: 1rem;
  transition: background 0.3s;
}

.btn-remove-logo:hover {
  background: #cc0000;
}

.logo-placeholder {
  padding: 2rem;
  color: #999;
  font-size: 1.2rem;
}

.btn-upload {
  background: #667eea;
  color: white;
  border: none;
  padding: 0.75rem 1.5rem;
  border-radius: 8px;
  cursor: pointer;
  font-size: 1rem;
  transition: background 0.3s;
}

.btn-upload:hover {
  background: #5568d3;
}

.hint {
  margin-top: 0.5rem;
  font-size: 0.875rem;
  color: #999;
}

.form-actions {
  margin-top: 2rem;
  padding-top: 2rem;
  border-top: 1px solid #e0e0e0;
}

.btn-save {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border: none;
  padding: 1rem 2rem;
  border-radius: 8px;
  cursor: pointer;
  font-size: 1rem;
  font-weight: 600;
  transition: transform 0.2s;
}

.btn-save:hover:not(:disabled) {
  transform: translateY(-2px);
}

.btn-save:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.message {
  margin-top: 1rem;
  padding: 1rem;
  border-radius: 8px;
  text-align: center;
  font-weight: 500;
}

.message.success {
  background: #d4edda;
  color: #155724;
  border: 1px solid #c3e6cb;
}

.message.error {
  background: #f8d7da;
  color: #721c24;
  border: 1px solid #f5c6cb;
}

.batch-send-section {
  margin-top: 30px;
  padding-top: 30px;
  border-top: 1px solid #e0e0e0;
}

.quota-display {
  background: #e8f5e9;
  padding: 12px;
  border-radius: 6px;
  margin-bottom: 15px;
  color: #2e7d32;
  font-size: 14px;
}

.quota-display.quota-warning {
  background: #fff3e0;
  color: #e65100;
}

.quota-display.quota-depleted {
  background: #ffebee;
  color: #c62828;
}

.batch-send-section h3 {
  margin-bottom: 10px;
  color: #333;
  font-size: 18px;
}

.btn-batch-send {
  background: #667eea;
  color: white;
  border: none;
  padding: 12px 24px;
  border-radius: 8px;
  font-size: 16px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s;
  margin-top: 15px;
}

.btn-batch-send:hover:not(:disabled) {
  background: #5568d3;
}

.btn-batch-send:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.batch-message {
  margin-top: 1rem;
  padding: 1rem;
  border-radius: 8px;
  text-align: center;
  font-weight: 500;
}

.batch-message.success {
  background: #d4edda;
  color: #155724;
  border: 1px solid #c3e6cb;
}

.batch-message.error {
  background: #f8d7da;
  color: #721c24;
  border: 1px solid #f5c6cb;
}

.batch-message.warning {
  background: #fff3cd;
  color: #856404;
  border: 1px solid #ffeaa7;
}

.batch-message.info {
  background: #d1ecf1;
  color: #0c5460;
  border: 1px solid #bee5eb;
}

.placeholder-text {
  color: #999;
  font-style: italic;
}

.export-buttons {
  display: flex;
  flex-direction: column;
  gap: 15px;
  margin-top: 20px;
}

.btn-export {
  padding: 15px 25px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 16px;
  font-weight: 500;
  cursor: pointer;
  transition: transform 0.2s, box-shadow 0.2s;
  box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.btn-export:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
}

.btn-export:active {
  transform: translateY(0);
}

.btn-report {
  background: linear-gradient(135deg, #28a745 0%, #20c997 100%);
  box-shadow: 0 2px 8px rgba(40, 167, 69, 0.3);
}

.btn-report:hover {
  box-shadow: 0 4px 12px rgba(40, 167, 69, 0.4);
}

@media (min-width: 768px) {
  .export-buttons {
    flex-direction: row;
  }
  
  .btn-export {
    flex: 1;
  }
}

/* SuperAdmin Section Styles */
.superadmin-section {
  border: 2px solid #ff4444;
  background: #fff5f5;
}

.superadmin-section h2 {
  color: #cc0000;
}

.superadmin-actions {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.action-item {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.lockdown-item {
  padding: 1rem;
  border: 2px solid #ff9800;
  border-radius: 8px;
  background: #fff9f0;
}

.lockdown-toggle {
  display: flex;
  align-items: center;
  gap: 15px;
}

/* Toggle Switch Styles */
.toggle-switch {
  position: relative;
  display: inline-block;
  width: 60px;
  height: 34px;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: #ccc;
  transition: 0.4s;
  border-radius: 34px;
}

.slider:before {
  position: absolute;
  content: "";
  height: 26px;
  width: 26px;
  left: 4px;
  bottom: 4px;
  background-color: white;
  transition: 0.4s;
  border-radius: 50%;
}

.toggle-switch input:checked + .slider {
  background-color: #ff4444;
}

.toggle-switch input:focus + .slider {
  box-shadow: 0 0 1px #ff4444;
}

.toggle-switch input:checked + .slider:before {
  transform: translateX(26px);
}

.toggle-switch input:disabled + .slider {
  opacity: 0.5;
  cursor: not-allowed;
}

.toggle-status {
  font-weight: 600;
  font-size: 1.1rem;
  color: #666;
}

.toggle-status.active {
  color: #ff4444;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.7;
  }
}

.btn-danger {
  background: #ff4444;
  color: white;
  border: none;
  padding: 1rem 2rem;
  border-radius: 8px;
  cursor: pointer;
  font-size: 1rem;
  font-weight: 600;
  transition: background 0.2s;
}

.btn-danger:hover:not(:disabled) {
  background: #cc0000;
}

.btn-danger:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.danger-hint {
  color: #cc0000;
  font-size: 0.875rem;
  font-weight: 500;
}

.action-message {
  margin-top: 1rem;
  padding: 1rem;
  border-radius: 8px;
  text-align: center;
  font-weight: 500;
}

.action-message.success {
  background: #d4edda;
  color: #155724;
  border: 1px solid #c3e6cb;
}

.action-message.error {
  background: #f8d7da;
  color: #721c24;
  border: 1px solid #f5c6cb;
}

.action-message.warning {
  background: #fff3cd;
  color: #856404;
  border: 1px solid #ffeaa7;
  font-size: 1rem;
}

/* Migration Section Styles */
.migration-section {
  border: 2px solid #667eea;
  background: #f0f4ff;
}

.migration-section h2 {
  color: #667eea;
}

.migration-subsection {
  margin-bottom: 2rem;
  padding-bottom: 2rem;
  border-bottom: 1px solid #d0d0d0;
}

.migration-subsection:last-of-type {
  border-bottom: none;
  margin-bottom: 0;
}

.migration-subsection h3 {
  color: #555;
  font-size: 1.25rem;
  margin-bottom: 0.5rem;
}

.receive-mode-toggle {
  margin: 1.5rem 0;
}

.toggle-label {
  display: flex;
  align-items: center;
  gap: 12px;
  font-weight: 600;
  color: #555;
  cursor: pointer;
}

.toggle-label input[type="checkbox"] {
  width: 24px;
  height: 24px;
  cursor: pointer;
}

.toggle-label span {
  font-size: 1rem;
}

.secret-display {
  margin-top: 1.5rem;
  padding: 1rem;
  background: white;
  border-radius: 8px;
  border: 1px solid #e0e0e0;
}

.secret-display label {
  display: block;
  margin-bottom: 0.5rem;
  font-weight: 600;
  color: #555;
}

.secret-key-box {
  display: flex;
  gap: 10px;
  align-items: center;
  background: #f5f5f5;
  padding: 1rem;
  border-radius: 8px;
  border: 1px solid #d0d0d0;
}

.secret-key-box code {
  flex: 1;
  font-family: 'Courier New', monospace;
  font-size: 0.875rem;
  word-break: break-all;
  color: #333;
}

.btn-copy {
  background: #667eea;
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.875rem;
  font-weight: 500;
  transition: background 0.2s;
  display: flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}

.btn-copy:hover {
  background: #5568d3;
}

.btn-export-db {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border: none;
  padding: 1rem 2rem;
  border-radius: 8px;
  cursor: pointer;
  font-size: 1rem;
  font-weight: 600;
  transition: transform 0.2s;
  margin-top: 1rem;
}

.btn-export-db:hover:not(:disabled) {
  transform: translateY(-2px);
}

.btn-export-db:disabled {
  opacity: 0.6;
  cursor: not-allowed;
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

  .settings-card {
    padding: 20px;
  }

  .settings-card h2 {
    font-size: 20px;
  }

  .settings-card h3 {
    font-size: 18px;
  }

  .form-group label {
    font-size: 14px;
  }

  .form-group input,
  .form-group select,
  .form-group textarea {
    font-size: 14px;
  }

  .hint {
    font-size: 12px;
  }

  .logo-preview img {
    max-width: 150px;
    max-height: 150px;
  }

  .logo-buttons {
    flex-direction: column;
    gap: 10px;
  }

  .logo-buttons button {
    width: 100%;
  }

  .form-actions {
    flex-direction: column;
  }

  .btn-save,
  .btn-batch-send,
  .btn-danger,
  .btn-export-db {
    width: 100%;
  }

  .batch-send-section h3 {
    font-size: 16px;
  }

  .export-buttons {
    gap: 10px;
  }

  .btn-export {
    padding: 12px 20px;
    font-size: 14px;
  }
}
</style>
