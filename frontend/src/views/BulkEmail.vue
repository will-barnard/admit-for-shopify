<template>
  <div class="bulk-email">
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

      <div class="page-header">
        <h1>📧 Bulk Email</h1>
        <p class="subtitle">Send emails to event attendees</p>
      </div>

      <!-- Event Selection -->
      <div class="section">
        <h2>Recipients</h2>
        <div class="event-selection">
          <label class="checkbox-label">
            <input type="checkbox" v-model="selectAll" @change="handleSelectAll" />
            <span class="checkbox-text">All Events</span>
          </label>
          <label v-for="event in events" :key="event.id" class="checkbox-label">
            <input type="checkbox" :value="event.id" v-model="selectedEventIds" :disabled="selectAll" />
            <span class="checkbox-text">{{ event.name }}</span>
          </label>
        </div>

        <button 
          @click="loadPreview" 
          class="btn-secondary"
          :disabled="selectedEventIds.length === 0 && !selectAll"
          style="margin-top: 1rem;"
        >
          Preview Recipients
        </button>

        <div v-if="preview" class="preview-box">
          <h3>📊 Recipient Count</h3>
          <div class="preview-stats">
            <div v-for="item in preview.breakdown" :key="item.event_id || item.event_name" class="stat-item">
              <span class="stat-label">{{ item.event_name }}:</span>
              <span class="stat-value">{{ item.count }}</span>
            </div>
            <div class="stat-item total">
              <span class="stat-label">Total Recipients:</span>
              <span class="stat-value">{{ preview.total }}</span>
            </div>
          </div>
        </div>

        <!-- Individual recipient list -->
        <div v-if="recipients.length > 0" class="recipient-list-box">
          <div class="recipient-list-header">
            <h3>👥 Select Recipients <span class="selected-count">({{ selectedRecipientCount }} of {{ recipients.length }} selected)</span></h3>
            <div class="recipient-list-actions">
              <button @click="selectAllRecipients" class="btn-link">Select All</button>
              <span class="divider">|</span>
              <button @click="deselectAllRecipients" class="btn-link">Deselect All</button>
            </div>
          </div>
          <div class="recipient-list">
            <label v-for="r in recipients" :key="r.email" class="recipient-row">
              <input type="checkbox" v-model="r.selected" />
              <span class="recipient-name">{{ r.name }}</span>
              <span class="recipient-email">{{ r.email }}</span>
              <span class="recipient-event">{{ r.event_name }}</span>
            </label>
          </div>
        </div>
      </div>

      <!-- Email Composition -->
      <div class="section">
        <h2>Email Content</h2>
        <div class="form-group">
          <label>Subject *</label>
          <input 
            v-model="subject" 
            type="text" 
            placeholder="Email subject line"
            class="form-input"
          />
        </div>

        <div class="form-group">
          <label>Message Body * (HTML supported)</label>
          <textarea 
            v-model="body" 
            rows="12"
            placeholder="Enter your message here. You can use HTML for formatting."
            class="form-textarea"
          ></textarea>
          <p class="hint">
            Tip: Use HTML tags like &lt;strong&gt;, &lt;em&gt;, &lt;p&gt;, &lt;br&gt;, &lt;ul&gt;, &lt;li&gt; for formatting
          </p>
        </div>

        <div class="toggle-options">
          <label class="toggle-label">
            <input type="checkbox" v-model="includeLogo" />
            <span>Include logo banner at top of email</span>
          </label>
          <label class="toggle-label">
            <input type="checkbox" v-model="showTicketHolder" />
            <span>Show "Ticket holder: [name]" footer</span>
          </label>
        </div>
      </div>

      <!-- Test Email -->
      <div class="section">
        <h2>🧪 Test Email</h2>
        <p class="description">Send a test email to verify formatting before sending to all recipients</p>
        
        <div class="form-group">
          <label>Test Email Address *</label>
          <input 
            v-model="testEmail" 
            type="email" 
            placeholder="your.email@example.com"
            class="form-input"
          />
        </div>

        <button 
          @click="sendTestEmail" 
          class="btn-test"
          :disabled="!canSendTest || sendingTest"
        >
          {{ sendingTest ? 'Sending Test...' : 'Send Test Email' }}
        </button>

        <div v-if="testResult" :class="['result-message', testResult.type]">
          {{ testResult.message }}
        </div>
      </div>

      <!-- Send Bulk Email -->
      <div class="section">
        <h2>⚠️ Send Bulk Email</h2>
        <p class="description warning">
          This will send the email to all selected recipients. This action cannot be undone.
          Emails are sent at a rate of 10 per minute to comply with rate limits.
        </p>

        <button 
          @click="confirmSend" 
          class="btn-send"
          :disabled="!canSendBulk || sending || jobRunning"
        >
          {{ sending ? 'Queueing...' : 'Send Bulk Email' }}
        </button>

        <div v-if="sendResult" :class="['result-message', sendResult.type]">
          {{ sendResult.message }}
        </div>

        <!-- Sending happens on the server now, so this is a view of a job
             rather than a request in flight. Closing the page is fine. -->
        <div v-if="job" class="progress-info">
          <div class="progress-head">
            <strong>{{ statusLabel }}</strong>
            <span class="progress-count">{{ job.sent }} sent<span v-if="job.failed"> · {{ job.failed }} failed</span> of {{ job.total }}</span>
          </div>
          <div class="progress-track">
            <div class="progress-bar" :style="{ width: progressPercent + '%' }"></div>
          </div>
          <p class="progress-note">
            <template v-if="jobRunning">
              This keeps running on the server - you can close this page and come back.
            </template>
            <template v-else-if="job.status === 'completed' && !job.failed">All messages were accepted.</template>
            <template v-else-if="job.status === 'cancelled'">Cancelled. Messages already handed to Resend were still delivered.</template>
          </p>
          <p v-if="job.error_message" class="progress-warning">{{ job.error_message }}</p>
          <p v-if="Number(job.unknown) > 0" class="progress-warning">
            {{ job.unknown }} message(s) were interrupted mid-send and were not retried, to avoid
            delivering twice. Check Resend if you need to know whether they arrived.
          </p>

          <ul v-if="job.failures && job.failures.length" class="failure-list">
            <li v-for="f in job.failures" :key="f.email">
              <strong>{{ f.email }}</strong> — {{ f.error || 'interrupted' }}
            </li>
          </ul>

          <div class="progress-actions">
            <button v-if="jobRunning" @click="cancelJob" class="btn-secondary">Stop sending</button>
            <button v-else @click="job = null" class="btn-secondary">Dismiss</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Confirmation Modal -->
    <div v-if="showConfirmModal" class="modal-overlay" @click="showConfirmModal = false">
      <div class="modal-content" @click.stop>
        <div class="modal-header">
          <h2>⚠️ Confirm Bulk Email</h2>
          <button @click="showConfirmModal = false" class="btn-close">×</button>
        </div>
        <div class="modal-body">
          <p><strong>You are about to send this email to {{ selectedRecipientCount }} recipient(s).</strong></p>
          <p>Subject: <em>{{ subject }}</em></p>
          <p>This action cannot be undone. Are you sure you want to continue?</p>
        </div>
        <div class="modal-footer">
          <button @click="showConfirmModal = false" class="btn-secondary">Cancel</button>
          <button @click="sendBulkEmail" class="btn-danger">Yes, Send Email</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import axios from 'axios';
import ChangePasswordModal from '@/components/ChangePasswordModal.vue';
import PageHeader from '@/components/PageHeader.vue';

export default {
  name: 'BulkEmail',
  components: {
    ChangePasswordModal,
    PageHeader,
  },
  setup() {
    const router = useRouter();
    const authStore = useAuthStore();

    const isChangePasswordOpen = ref(false);
    const events = ref([]);
    const selectAll = ref(false);
    const selectedEventIds = ref([]);
    const recipients = ref([]);
    const subject = ref('');
    const body = ref('');
    const testEmail = ref('');
    const preview = ref(null);
    const showTicketHolder = ref(true);
    const includeLogo = ref(false);
    const sendingTest = ref(false);
    const sending = ref(false);
    const testResult = ref(null);
    const sendResult = ref(null);

    // The job being watched. Sending no longer happens inside the request, so
    // the page polls rather than waiting: a hundred recipients six seconds
    // apart used to be ten minutes against a sixty-second proxy timeout, which
    // meant a guaranteed 504 and no idea what had actually gone out.
    const job = ref(null);
    let pollTimer = null;
    const showConfirmModal = ref(false);

    const selectedRecipientCount = computed(() => recipients.value.filter(r => r.selected).length);

    const canSendTest = computed(() => {
      return subject.value.trim() && body.value.trim() && testEmail.value.trim();
    });

    const canSendBulk = computed(() => {
      return subject.value.trim() && body.value.trim() && selectedRecipientCount.value > 0;
    });

    const loadEvents = async () => {
      try {
        const response = await axios.get('/api/events/list/active');
        events.value = response.data;
      } catch (err) {
        console.error('Error loading events:', err);
      }
    };

    const handleSelectAll = () => {
      if (selectAll.value) {
        selectedEventIds.value = events.value.map(e => e.id);
      } else {
        selectedEventIds.value = [];
      }
      preview.value = null;
      recipients.value = [];
    };

    const loadPreview = async () => {
      try {
        const eventIds = selectAll.value ? events.value.map(e => e.id) : selectedEventIds.value;
        const [countRes, listRes] = await Promise.all([
          axios.post('/api/bulk-email/preview', { eventIds }),
          axios.post('/api/bulk-email/preview/list', { eventIds })
        ]);
        preview.value = countRes.data;
        recipients.value = listRes.data.recipients.map(r => ({ ...r, selected: true }));
      } catch (error) {
        console.error('Error loading preview:', error);
        alert('Failed to load recipient preview');
      }
    };

    const selectAllRecipients = () => {
      recipients.value.forEach(r => r.selected = true);
    };

    const deselectAllRecipients = () => {
      recipients.value.forEach(r => r.selected = false);
    };

    const sendTestEmail = async () => {
      sendingTest.value = true;
      testResult.value = null;

      try {
        const response = await axios.post('/api/bulk-email/test', {
          subject: subject.value,
          body: body.value,
          testEmail: testEmail.value,
          includeLogo: includeLogo.value
        });

        const logoNote = response.data.logoUrl ? ` (logo: ${response.data.logoUrl})` : '';
        testResult.value = {
          type: 'success',
          message: response.data.message + logoNote
        };
      } catch (error) {
        console.error('Error sending test email:', error);
        testResult.value = {
          type: 'error',
          message: error.response?.data?.error || 'Failed to send test email'
        };
      } finally {
        sendingTest.value = false;
      }
    };

    const confirmSend = () => {
      showConfirmModal.value = true;
    };

    const jobRunning = computed(() => ['queued', 'running'].includes(job.value?.status));

    const statusLabel = computed(() => ({
      queued: 'Queued',
      running: 'Sending',
      completed: 'Finished',
      cancelled: 'Cancelled',
      failed: 'Failed',
    }[job.value?.status] || ''));

    const progressPercent = computed(() => {
      const total = Number(job.value?.total || 0);
      if (!total) return 0;
      return Math.round(((Number(job.value.sent) + Number(job.value.failed)) / total) * 100);
    });

    const stopPolling = () => {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
    };

    const pollJob = async (jobId) => {
      try {
        const { data } = await axios.get(`/api/bulk-email/jobs/${jobId}`);
        job.value = data;
        if (['queued', 'running'].includes(data.status)) {
          pollTimer = setTimeout(() => pollJob(jobId), 3000);
          return;
        }
      } catch (err) {
        console.error('Error polling email job:', err);
      }
      stopPolling();
    };

    const cancelJob = async () => {
      if (!job.value) return;
      if (!confirm('Stop sending? Messages already handed to Resend cannot be recalled.')) return;
      try {
        await axios.post(`/api/bulk-email/jobs/${job.value.id}/cancel`);
        await pollJob(job.value.id);
      } catch (err) {
        sendResult.value = { type: 'error', message: err.response?.data?.error || 'Could not cancel' };
      }
    };

    // If a job is already running - started here, or before a page reload -
    // pick it back up rather than pretending nothing is happening.
    const resumeActiveJob = async () => {
      try {
        const { data } = await axios.get('/api/bulk-email/jobs');
        const active = (data.jobs || []).find((j) => ['queued', 'running'].includes(j.status));
        if (active) await pollJob(active.id);
      } catch (err) {
        /* the panel simply stays hidden */
      }
    };

    const sendBulkEmail = async () => {
      showConfirmModal.value = false;
      sending.value = true;
      sendResult.value = null;

      try {
        const emails = recipients.value.filter(r => r.selected).map(r => r.email);
        const response = await axios.post('/api/bulk-email/send', {
          subject: subject.value,
          body: body.value,
          emails,
          showTicketHolder: showTicketHolder.value,
          includeLogo: includeLogo.value
        });

        sendResult.value = {
          type: 'success',
          message: `Queued for ${response.data.total} recipient(s). Sending continues on the server.`
        };

        subject.value = '';
        body.value = '';
        preview.value = null;
        recipients.value = [];
        showTicketHolder.value = true;
        includeLogo.value = false;

        await pollJob(response.data.jobId);
      } catch (error) {
        console.error('Error sending bulk email:', error);
        sendResult.value = {
          type: 'error',
          message: error.response?.data?.error || 'Failed to queue bulk email'
        };
        // A 409 names the job already in flight - show that instead of nothing.
        if (error.response?.status === 409 && error.response.data?.jobId) {
          await pollJob(error.response.data.jobId);
        }
      } finally {
        sending.value = false;
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
      loadEvents();
      resumeActiveJob();
    });

    onUnmounted(stopPolling);

    return {
      authStore,
      isChangePasswordOpen,
      events,
      selectAll,
      selectedEventIds,
      recipients,
      selectedRecipientCount,
      subject,
      body,
      testEmail,
      preview,
      sendingTest,
      sending,
      testResult,
      sendResult,
      job,
      jobRunning,
      statusLabel,
      progressPercent,
      cancelJob,
      showConfirmModal,
      showTicketHolder,
      includeLogo,
      canSendTest,
      canSendBulk,
      handleSelectAll,
      loadPreview,
      selectAllRecipients,
      deselectAllRecipients,
      sendTestEmail,
      confirmSend,
      sendBulkEmail,
      showChangePassword,
      handleLogout,
    };
  },
};
</script>

<style scoped>
.bulk-email {
  min-height: 100vh;
  background: #f5f5f5;
}

.container {
  max-width: 900px;
  margin: 0 auto;
  padding: 20px;
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

.page-header {
  margin-bottom: 2rem;
}

.page-header h1 {
  font-size: 2rem;
  margin-bottom: 0.5rem;
  color: #333;
}

.subtitle {
  color: #666;
  font-size: 1rem;
}

.section {
  background: white;
  border-radius: 8px;
  padding: 2rem;
  margin-bottom: 1.5rem;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

.section h2 {
  margin-top: 0;
  margin-bottom: 1.5rem;
  color: #333;
  font-size: 1.3rem;
}

.description {
  color: #666;
  margin-bottom: 1rem;
  line-height: 1.6;
}

.description.warning {
  color: #d32f2f;
  font-weight: 500;
}

.event-selection {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  font-size: 1rem;
}

.checkbox-label input[type="checkbox"] {
  width: 18px;
  height: 18px;
  cursor: pointer;
}

.checkbox-label input[type="checkbox"]:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.checkbox-text {
  font-weight: 500;
  color: #333;
}

.form-group {
  margin-bottom: 1.5rem;
}

.form-group label {
  display: block;
  margin-bottom: 0.5rem;
  font-weight: 600;
  color: #333;
}

.form-input,
.form-textarea {
  width: 100%;
  padding: 0.75rem;
  border: 2px solid #e0e0e0;
  border-radius: 6px;
  font-size: 1rem;
  font-family: inherit;
  transition: border-color 0.2s;
  box-sizing: border-box;
}

.form-input:focus,
.form-textarea:focus {
  outline: none;
  border-color: #667eea;
}

.form-textarea {
  resize: vertical;
  min-height: 200px;
}

.hint {
  margin-top: 0.5rem;
  font-size: 0.85rem;
  color: #999;
  font-style: italic;
}

.preview-box {
  margin-top: 1.5rem;
  padding: 1.5rem;
  background: #f8f9fa;
  border-radius: 6px;
  border: 1px solid #dee2e6;
}

.preview-box h3 {
  margin-top: 0;
  margin-bottom: 1rem;
  color: #333;
  font-size: 1.1rem;
}

.preview-stats {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.stat-item {
  display: flex;
  justify-content: space-between;
  padding: 0.5rem;
  background: white;
  border-radius: 4px;
}

.stat-item.total {
  background: #667eea;
  color: white;
  font-weight: 600;
  margin-top: 0.5rem;
}

.stat-label { font-weight: 500; }
.stat-value { font-weight: 600; }

.btn-secondary,
.btn-test,
.btn-send,
.btn-danger {
  padding: 0.75rem 1.5rem;
  border: none;
  border-radius: 6px;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-secondary {
  background: white;
  color: #667eea;
  border: 2px solid #667eea;
}

.btn-secondary:hover:not(:disabled) { background: #f0f0ff; }

.btn-test { background: #ff9800; color: white; }
.btn-test:hover:not(:disabled) { background: #f57c00; }

.btn-send { background: #4caf50; color: white; }
.btn-send:hover:not(:disabled) { background: #45a049; }

.btn-danger { background: #f44336; color: white; }
.btn-danger:hover { background: #d32f2f; }

button:disabled { opacity: 0.5; cursor: not-allowed; }

.result-message {
  margin-top: 1rem;
  padding: 1rem;
  border-radius: 6px;
  font-weight: 500;
}

.result-message.success {
  background: #d4edda;
  color: #155724;
  border: 1px solid #c3e6cb;
}

.result-message.error {
  background: #f8d7da;
  color: #721c24;
  border: 1px solid #f5c6cb;
}

.progress-info {
  margin-top: 1rem;
  padding: 1rem;
  background: #fff3cd;
  border: 1px solid #ffeaa7;
  border-radius: 6px;
  color: #856404;
}

.progress-info p { margin: 0.5rem 0; }

.modal-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}

.modal-content {
  background: white;
  border-radius: 8px;
  max-width: 500px;
  width: 90%;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1.5rem;
  border-bottom: 1px solid #e0e0e0;
}

.modal-header h2 { margin: 0; font-size: 1.5rem; color: #333; }

.btn-close {
  background: none;
  border: none;
  font-size: 2rem;
  cursor: pointer;
  color: #999;
  line-height: 1;
  padding: 0;
}

.btn-close:hover { color: #333; }

.modal-body { padding: 1.5rem; }
.modal-body p { margin: 0.75rem 0; line-height: 1.6; }

.modal-footer {
  display: flex;
  gap: 1rem;
  justify-content: flex-end;
  padding: 1.5rem;
  border-top: 1px solid #e0e0e0;
}

.toggle-options {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.toggle-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  font-size: 0.95rem;
  color: #333;
}

.toggle-label input[type="checkbox"] {
  width: 16px;
  height: 16px;
  cursor: pointer;
}

.recipient-list-box {
  margin-top: 1.5rem;
  border: 1px solid #dee2e6;
  border-radius: 6px;
  overflow: hidden;
}

.recipient-list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  background: #f8f9fa;
  border-bottom: 1px solid #dee2e6;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.recipient-list-header h3 {
  margin: 0;
  font-size: 1rem;
  color: #333;
}

.selected-count {
  font-weight: normal;
  color: #667eea;
  font-size: 0.9rem;
}

.recipient-list-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.btn-link {
  background: none;
  border: none;
  color: #667eea;
  font-size: 0.85rem;
  cursor: pointer;
  padding: 0;
  font-weight: 600;
  text-decoration: underline;
}

.btn-link:hover { color: #5a67d8; }

.divider { color: #ccc; font-size: 0.85rem; }

.recipient-list {
  max-height: 320px;
  overflow-y: auto;
}

.recipient-row {
  display: grid;
  grid-template-columns: auto 1fr 1.5fr auto;
  align-items: center;
  gap: 0.75rem;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid #f0f0f0;
  cursor: pointer;
  transition: background 0.1s;
}

.recipient-row:last-child { border-bottom: none; }
.recipient-row:hover { background: #f8f9fa; }

.recipient-row input[type="checkbox"] {
  width: 16px;
  height: 16px;
  cursor: pointer;
  flex-shrink: 0;
}

.recipient-name {
  font-weight: 500;
  color: #333;
  font-size: 0.9rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recipient-email {
  color: #666;
  font-size: 0.85rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recipient-event {
  color: #999;
  font-size: 0.8rem;
  white-space: nowrap;
  text-align: right;
}

@media (max-width: 768px) {
  .container { padding: 15px; }
  .section { padding: 1.5rem; }
  .nav-tabs { overflow-x: auto; scrollbar-width: none; }
  .nav-tabs::-webkit-scrollbar { display: none; }
  .recipient-row { grid-template-columns: auto 1fr 1fr; }
  .recipient-event { display: none; }
}

.progress-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 8px; }
.progress-count { font-size: 13px; color: #555; }
.progress-track { height: 8px; background: #e6e8f0; border-radius: 4px; overflow: hidden; }
.progress-bar { height: 100%; background: #667eea; transition: width 0.4s ease; }
.progress-note { font-size: 13px; color: #666; margin: 8px 0 0; }
.progress-warning { font-size: 13px; color: #8a5a00; background: #fff6e5; border: 1px solid #ffe0a3; border-radius: 6px; padding: 8px 10px; margin: 8px 0 0; }
.failure-list { margin: 10px 0 0; padding-left: 18px; font-size: 13px; color: #c33; max-height: 180px; overflow-y: auto; }
.progress-actions { margin-top: 12px; }
</style>
