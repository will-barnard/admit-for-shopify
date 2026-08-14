<template>
  <div class="events">
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
        <h2>Events</h2>
        <div class="page-header-actions">
          <label class="show-archived-toggle">
            <input v-model="showArchived" type="checkbox" @change="loadEvents" />
            Show archived
          </label>
          <button @click="openCreateModal" class="btn-primary">+ New Event</button>
        </div>
      </div>

      <div v-if="loading" class="loading">Loading events...</div>
      <div v-else-if="error" class="error-message">{{ error }}</div>

      <div v-else class="events-list">
        <div v-if="events.length === 0" class="empty-state">
          <p>No events yet. Create your first event to get started.</p>
        </div>

        <div
          v-for="event in events"
          :key="event.id"
          class="event-card"
          :class="{ inactive: !event.active, archived: event.archived }"
        >
          <div class="event-info">
            <div class="event-header">
              <h3>{{ event.name }}</h3>
              <span v-if="event.archived" class="badge archived-badge">Archived</span>
              <span v-else class="badge" :class="event.active ? 'active' : 'inactive'">
                {{ event.active ? 'Active' : 'Inactive' }}
              </span>
            </div>
            <p v-if="event.description" class="event-desc">{{ event.description }}</p>
            <div class="event-meta">
              <span v-if="event.event_date"><strong>Date:</strong> {{ formatDate(event.event_date) }}</span>
              <span v-if="event.event_time"><strong>Time:</strong> {{ event.event_time }}</span>
              <span v-if="event.location"><strong>Location:</strong> {{ event.location }}</span>
              <span><strong>SKU:</strong> {{ event.sku }}</span>
              <span v-if="event.archived && event.archived_at">
                <strong>Archived:</strong> {{ formatDate(event.archived_at) }}
              </span>
            </div>
            <div class="event-stats">
              <span class="stat">{{ event.ticket_count || 0 }} tickets</span>
              <span class="stat">{{ event.checkin_count || 0 }} checked in</span>
            </div>
          </div>
          <div class="event-actions">
            <button @click="openEditModal(event)" class="btn-small" :disabled="event.archived">Edit</button>
            <button
              v-if="!event.archived"
              @click="archiveEvent(event)"
              class="btn-small"
              title="Hide this event from the dashboard and stats. Tickets become unscannable."
            >
              Archive
            </button>
            <button
              v-else
              @click="unarchiveEvent(event)"
              class="btn-small"
              title="Restore this event to the dashboard."
            >
              Unarchive
            </button>
            <button
              @click="deleteEvent(event)"
              class="btn-small btn-danger"
              :disabled="event.ticket_count > 0"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Create/Edit Modal -->
    <div v-if="showModal" class="modal-overlay" @click.self="closeModal">
      <div class="modal">
        <h3>{{ editingEvent ? 'Edit Event' : 'Create Event' }}</h3>
        <form @submit.prevent="saveEvent">
          <div class="form-group">
            <label>Event Name *</label>
            <input v-model="form.name" type="text" required placeholder="e.g. Summer Music Festival" />
          </div>
          <div class="form-group">
            <label>Description</label>
            <textarea v-model="form.description" placeholder="Optional description" rows="3"></textarea>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Event Date</label>
              <input v-model="form.event_date" type="date" />
            </div>
            <div class="form-group">
              <label>Event Time</label>
              <input v-model="form.event_time" type="text" placeholder="e.g. 10:00 AM - 6:00 PM" />
            </div>
          </div>
          <div class="form-group">
            <label>Location</label>
            <input v-model="form.location" type="text" placeholder="e.g. Convention Center, Hall A" />
          </div>
          <div class="form-group">
            <label>Shopify SKU *</label>
            <input v-model="form.sku" type="text" required placeholder="e.g. summer-fest-2025" />
            <p class="hint">Must match the SKU in your Shopify product</p>
          </div>
          <div class="form-group">
            <label class="checkbox-label">
              <input v-model="form.active" type="checkbox" />
              Active (accepts new tickets)
            </label>
          </div>
          <div v-if="modalError" class="error-message">{{ modalError }}</div>
          <div class="modal-actions">
            <button type="button" @click="closeModal" class="btn-secondary">Cancel</button>
            <button type="submit" class="btn-primary" :disabled="saving">
              {{ saving ? 'Saving...' : (editingEvent ? 'Update' : 'Create') }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, reactive, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import axios from 'axios';
import ChangePasswordModal from '@/components/ChangePasswordModal.vue';
import PageHeader from '@/components/PageHeader.vue';

export default {
  name: 'Events',
  components: { ChangePasswordModal, PageHeader },
  setup() {
    const router = useRouter();
    const authStore = useAuthStore();

    const events = ref([]);
    const loading = ref(true);
    const error = ref('');
    const isChangePasswordOpen = ref(false);
    const showModal = ref(false);
    const editingEvent = ref(null);
    const saving = ref(false);
    const modalError = ref('');
    const showArchived = ref(false);

    const form = reactive({
      name: '',
      description: '',
      event_date: '',
      event_time: '',
      location: '',
      sku: '',
      active: true
    });

    const resetForm = () => {
      form.name = '';
      form.description = '';
      form.event_date = '';
      form.event_time = '';
      form.location = '';
      form.sku = '';
      form.active = true;
      modalError.value = '';
    };

    const loadEvents = async () => {
      loading.value = true;
      try {
        const params = showArchived.value ? { include_archived: 'true' } : {};
        const response = await axios.get('/api/events', { params });
        events.value = response.data;
      } catch (err) {
        error.value = 'Failed to load events';
      } finally {
        loading.value = false;
      }
    };

    const openCreateModal = () => {
      resetForm();
      editingEvent.value = null;
      showModal.value = true;
    };

    const openEditModal = (event) => {
      editingEvent.value = event;
      form.name = event.name;
      form.description = event.description || '';
      form.event_date = event.event_date ? event.event_date.split('T')[0] : '';
      form.event_time = event.event_time || '';
      form.location = event.location || '';
      form.sku = event.sku;
      form.active = event.active;
      modalError.value = '';
      showModal.value = true;
    };

    const closeModal = () => {
      showModal.value = false;
      editingEvent.value = null;
    };

    const saveEvent = async () => {
      saving.value = true;
      modalError.value = '';
      try {
        const payload = { ...form };
        if (!payload.event_date) payload.event_date = null;

        if (editingEvent.value) {
          await axios.put(`/api/events/${editingEvent.value.id}`, payload);
        } else {
          await axios.post('/api/events', payload);
        }
        closeModal();
        await loadEvents();
      } catch (err) {
        modalError.value = err.response?.data?.error || 'Failed to save event';
      } finally {
        saving.value = false;
      }
    };

    const deleteEvent = async (event) => {
      if (event.ticket_count > 0) return;
      if (!confirm(`Delete "${event.name}"? This cannot be undone.`)) return;
      try {
        await axios.delete(`/api/events/${event.id}`);
        await loadEvents();
      } catch (err) {
        alert(err.response?.data?.error || 'Failed to delete event');
      }
    };

    const archiveEvent = async (event) => {
      const msg = `Archive "${event.name}"? It will be hidden from the dashboard and stats, and its tickets will no longer be scannable. You can unarchive it later.`;
      if (!confirm(msg)) return;
      try {
        await axios.post(`/api/events/${event.id}/archive`);
        await loadEvents();
      } catch (err) {
        alert(err.response?.data?.error || 'Failed to archive event');
      }
    };

    const unarchiveEvent = async (event) => {
      try {
        await axios.post(`/api/events/${event.id}/unarchive`);
        await loadEvents();
      } catch (err) {
        alert(err.response?.data?.error || 'Failed to unarchive event');
      }
    };

    const formatDate = (dateStr) => {
      if (!dateStr) return '';
      return new Date(dateStr).toLocaleDateString();
    };

    const showChangePassword = () => { isChangePasswordOpen.value = true; };
    const handleLogout = () => { authStore.logout(); router.push('/login'); };

    onMounted(() => {
      authStore.initAuth();
      loadEvents();
    });

    return {
      authStore, events, loading, error, isChangePasswordOpen, showModal,
      editingEvent, saving, modalError, form, showArchived,
      openCreateModal, openEditModal, closeModal, saveEvent, deleteEvent,
      archiveEvent, unarchiveEvent, loadEvents,
      formatDate, showChangePassword, handleLogout
    };
  }
};
</script>

<style scoped>
.events { min-height: 100vh; background: #f5f5f5; }
.container { max-width: 1400px; margin: 0 auto; padding: 30px; }
.nav-tabs { display: flex; gap: 10px; margin-bottom: 30px; border-bottom: 2px solid #e0e0e0; }
.nav-tab { padding: 12px 24px; text-decoration: none; color: #666; border-bottom: 3px solid transparent; margin-bottom: -2px; transition: all 0.2s; font-weight: 500; }
.nav-tab:hover { color: #667eea; }
.nav-tab.active { color: #667eea; border-bottom-color: #667eea; }

.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
.page-header h2 { margin: 0; color: #333; font-size: 28px; }
.page-header-actions { display: flex; align-items: center; gap: 16px; }
.show-archived-toggle { display: flex; align-items: center; gap: 6px; font-size: 14px; color: #555; cursor: pointer; user-select: none; }
.show-archived-toggle input { width: auto; cursor: pointer; }

.events-list { display: flex; flex-direction: column; gap: 16px; }
.empty-state { text-align: center; padding: 60px 20px; color: #888; background: white; border-radius: 12px; }

.event-card {
  background: white; padding: 24px; border-radius: 12px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1); display: flex;
  justify-content: space-between; align-items: flex-start; gap: 20px;
  transition: transform 0.2s;
}
.event-card:hover { transform: translateY(-1px); }
.event-card.inactive { opacity: 0.7; }
.event-card.archived { opacity: 0.6; background: #fafafa; border-left: 4px solid #999; }

.event-header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.event-header h3 { margin: 0; color: #333; }
.event-desc { color: #666; margin: 0 0 12px 0; font-size: 14px; }

.event-meta { display: flex; flex-wrap: wrap; gap: 16px; font-size: 13px; color: #555; margin-bottom: 8px; }
.event-stats { display: flex; gap: 16px; font-size: 13px; }
.event-stats .stat { background: #f0f0f0; padding: 4px 10px; border-radius: 12px; }

.badge { padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
.badge.active { background: #e8f5e9; color: #2e7d32; }
.badge.inactive { background: #fce4ec; color: #c62828; }
.badge.archived-badge { background: #eceff1; color: #546e7a; }

.event-actions { display: flex; gap: 8px; flex-shrink: 0; }
.btn-small { padding: 8px 16px; border: 1px solid #ddd; border-radius: 6px; background: white; cursor: pointer; font-size: 13px; transition: background 0.2s; }
.btn-small:hover { background: #f5f5f5; }
.btn-danger { color: #c33; border-color: #fcc; }
.btn-danger:hover { background: #fee; }
.btn-danger:disabled { opacity: 0.4; cursor: not-allowed; }

.btn-primary { padding: 10px 24px; background: #667eea; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; transition: background 0.2s; }
.btn-primary:hover { background: #5568d3; }
.btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
.btn-secondary { padding: 10px 24px; background: white; color: #667eea; border: 1px solid #667eea; border-radius: 8px; cursor: pointer; font-size: 14px; }

.modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: white; padding: 32px; border-radius: 12px; width: 100%; max-width: 560px; max-height: 90vh; overflow-y: auto; }
.modal h3 { margin: 0 0 24px 0; font-size: 22px; color: #333; }

.form-group { margin-bottom: 18px; }
.form-group label { display: block; margin-bottom: 6px; font-weight: 500; color: #333; font-size: 14px; }
.form-group input[type="text"], .form-group input[type="date"], .form-group textarea {
  width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box;
}
.form-group textarea { resize: vertical; }
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.hint { font-size: 12px; color: #888; margin-top: 4px; }
.checkbox-label { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.checkbox-label input { width: auto; }

.modal-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 24px; }

.loading { text-align: center; padding: 40px; color: #666; }
.error-message { background: #fee; color: #c33; padding: 12px; border-radius: 6px; margin-bottom: 12px; }
</style>
