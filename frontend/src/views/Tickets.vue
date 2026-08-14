<template>
  <div class="tickets">
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

      <div v-if="loading" class="loading">Loading tickets...</div>

      <div v-else-if="error" class="error-message">
        {{ error }}
      </div>

      <div v-else-if="tickets.length === 0" class="empty-state">
        <p>No tickets issued yet.</p>
        <button @click="goToAddTicket" class="btn-primary">
          Issue Your First Ticket
        </button>
      </div>

      <div v-else class="tickets-content">
        <div class="filter-bar">
          <div class="filter-group">
            <label>Event:</label>
            <select v-model="filterEventId" class="filter-select">
              <option value="all">All Events</option>
              <option v-for="event in events" :key="event.id" :value="event.id">{{ event.name }}</option>
            </select>
          </div>
          <div class="filter-group">
            <label>
              <input type="checkbox" v-model="showNoEmailOnly" />
              No Email Only
            </label>
          </div>
        </div>

        <div class="search-bar">
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search by name, email, or order ID..."
            class="search-input"
          />
          <font-awesome-icon icon="search" class="search-icon" />
        </div>

        <div class="actions-bar">
          <button @click="goToAddTicket" class="btn-primary">
            + Add New Ticket
          </button>
          <button @click="loadTickets" class="btn-secondary">
            Refresh
          </button>
          <span class="ticket-count-label">{{ visibleTicketCount }} tickets</span>
        </div>

        <div class="tickets-table">
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Name</th>
                <th>Email</th>
                <th>Check-in Status</th>
                <th>Email Status</th>
                <th>Validity</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="group in groupedTickets" :key="group.orderId">
                <tr class="order-row" @click="toggleOrder(group.orderId)">
                  <td>
                    <div class="order-header">
                      <font-awesome-icon 
                        :icon="isOrderExpanded(group.orderId) ? 'chevron-down' : 'chevron-right'" 
                        class="expand-icon"
                      />
                      <span class="order-badge" :class="{ 'manual': !group.isShopifyOrder }">
                        <font-awesome-icon :icon="group.isShopifyOrder ? 'shopping-cart' : 'hand-point-right'" />
                        {{ group.isShopifyOrder ? 'Order' : 'Manual' }}
                      </span>
                    </div>
                  </td>
                  <td><strong>{{ group.customerName }}</strong></td>
                  <td>{{ group.customerEmail }}</td>
                  <td></td>
                  <td>
                    <span class="email-status-summary">
                      {{ group.tickets.filter(t => t.email_sent).length }} / {{ group.tickets.length }} sent
                    </span>
                  </td>
                  <td></td>
                  <td>{{ formatDate(group.tickets[0].created_at) }}</td>
                  <td>
                    <div class="order-actions">
                      <button 
                        v-if="(authStore.user?.role === 'admin' || authStore.user?.role === 'superadmin') && group.tickets.length === 1 && group.tickets.some(t => !t.email_sent) && group.tickets.every(t => !t.status || t.status === 'valid')"
                        @click.stop="sendAllTicketsEmail(group)"
                        class="btn-send-all"
                        title="Send ticket email"
                      >
                        Send Email
                      </button>
                      <button 
                        v-else-if="(authStore.user?.role === 'admin' || authStore.user?.role === 'superadmin') && group.tickets.length > 1 && group.tickets.some(t => !t.email_sent) && group.tickets.every(t => !t.status || t.status === 'valid')"
                        @click.stop="sendAllTicketsEmail(group)"
                        class="btn-send-all"
                        title="Send all tickets in one email"
                      >
                        Send All ({{ group.tickets.filter(t => !t.email_sent).length }})
                      </button>
                    </div>
                  </td>
                </tr>

                <template v-if="isOrderExpanded(group.orderId)">
                  <tr
                    v-for="ticket in group.tickets"
                    :key="ticket.id"
                    class="ticket-row"
                    :class="{ 'archived-row': ticket.event_archived }"
                  >
                    <td>
                      <span class="badge event-badge">{{ ticket.event_name || 'Unknown' }}</span>
                      <span v-if="ticket.event_archived" class="badge archived-event-badge" title="This event has been archived">
                        Archived event
                      </span>
                    </td>
                    <td>{{ ticket.name }}</td>
                    <td>
                      <div v-if="editingEmailForTicket === ticket.id" class="email-edit-container">
                        <input 
                          v-model="emailEditValue" 
                          type="email" 
                          class="email-edit-input"
                          placeholder="email@example.com"
                        />
                        <button @click="saveEmail(ticket)" class="btn-save-small">
                          <font-awesome-icon icon="check" />
                        </button>
                        <button @click="cancelEmailEdit()" class="btn-cancel-small">
                          <font-awesome-icon icon="times" />
                        </button>
                      </div>
                      <div v-else class="email-display">
                        <span>{{ ticket.email || '(no email)' }}</span>
                        <button @click="startEmailEdit(ticket)" class="btn-edit-small">
                          <font-awesome-icon icon="pencil-alt" />
                        </button>
                      </div>
                    </td>
                    <td>
                      <div class="scan-status">
                        <span v-if="ticket.scans?.scanned" class="scanned">
                          <font-awesome-icon icon="check-circle" class="check-icon" />
                          Scanned {{ formatScanDate(ticket.scans.scannedOn) }}
                          <span v-if="ticket.scans.scannedBy" class="scanner-info">
                            by {{ ticket.scans.scannedBy.username }}
                          </span>
                        </span>
                        <span v-else class="not-scanned">Not Scanned</span>
                      </div>
                    </td>
                    <td>
                      <div class="email-status-cell">
                        <span :class="['email-status-badge', { sent: ticket.email_sent }]">
                          {{ ticket.email_sent ? 'Sent' : 'Not Sent' }}
                        </span>
                        <button 
                          v-if="(authStore.user?.role === 'admin' || authStore.user?.role === 'superadmin') && ticket.email_sent && ticket.email && (!ticket.status || ticket.status === 'valid')" 
                          @click="sendTicketEmail(ticket.id)" 
                          class="btn-resend-email"
                          title="Resend ticket email"
                        >
                          <font-awesome-icon icon="redo" />
                          Resend
                        </button>
                      </div>
                    </td>
                    <td>
                      <select 
                        :value="ticket.status || 'valid'" 
                        @change="updateTicketStatus(ticket.id, $event.target.value)"
                        :class="['status-select', ticket.status || 'valid']"
                        @click.stop
                      >
                        <option value="valid">Valid</option>
                        <option value="invalid">Invalid</option>
                        <option value="refunded">Refunded</option>
                        <option value="cancelled">Cancelled</option>
                        <option value="chargeback">Chargeback</option>
                      </select>
                    </td>
                    <td>{{ formatDate(ticket.created_at) }}</td>
                    <td>
                      <div class="actions-cell">
                        <button 
                          v-if="authStore.user?.role === 'admin' || authStore.user?.role === 'superadmin'" 
                          @click="openEditModal(ticket)" 
                          class="btn-edit"
                          title="Edit Ticket"
                        >
                          Edit
                        </button>
                        <button 
                          v-if="(authStore.user?.role === 'admin' || authStore.user?.role === 'superadmin') && ticket.email && (!ticket.email_sent || emailJustChanged.has(ticket.id)) && (!ticket.status || ticket.status === 'valid')" 
                          @click="sendTicketEmail(ticket.id)" 
                          :class="['btn-send-email', { 'email-changed': emailJustChanged.has(ticket.id) }]"
                          :title="emailJustChanged.has(ticket.id) ? 'Email changed - Send ticket' : 'Send Ticket Email'"
                        >
                          <font-awesome-icon v-if="emailJustChanged.has(ticket.id)" icon="exclamation-circle" />
                          Send Email
                        </button>
                        <button 
                          v-if="authStore.user?.role === 'admin' || authStore.user?.role === 'superadmin'" 
                          @click="toggleScanStatus(ticket)" 
                          :class="['btn-scan', { scanned: ticket.scans?.scanned }]"
                          :title="ticket.scans?.scanned ? 'Mark as Not Scanned' : 'Mark as Scanned'"
                        >
                          {{ ticket.scans?.scanned ? 'Unmark Scan' : 'Mark Scanned' }}
                        </button>
                        <button @click="deleteTicket(ticket.id)" class="btn-delete">
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                </template>
              </template>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Edit Ticket Modal -->
    <div v-if="editingTicket" class="modal-overlay" @click="closeEditModal">
      <div class="modal-content" @click.stop>
        <div class="modal-header">
          <h2>Edit Ticket</h2>
          <button @click="closeEditModal" class="btn-close">&times;</button>
        </div>
        <div class="modal-body">
          <form @submit.prevent="saveTicketEdits">
            <div class="form-group">
              <label>Name</label>
              <input type="text" v-model="editForm.name" required />
            </div>
            
            <div class="form-group">
              <label>Email</label>
              <input type="email" v-model="editForm.email" />
            </div>
            
            <div class="form-actions">
              <button type="button" @click="closeEditModal" class="btn-secondary">
                Cancel
              </button>
              <button type="submit" class="btn-primary" :disabled="saving">
                {{ saving ? 'Saving...' : 'Save Changes' }}
              </button>
            </div>
          </form>
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
  name: 'Tickets',
  components: {
    ChangePasswordModal,
    PageHeader,
  },
  setup() {
    const router = useRouter();
    const authStore = useAuthStore();

    const tickets = ref([]);
    const events = ref([]);
    const loading = ref(true);
    const error = ref('');
    const isChangePasswordOpen = ref(false);
    const filterEventId = ref('all');
    const showNoEmailOnly = ref(false);
    const searchQuery = ref('');
    const editingTicket = ref(null);
    const saving = ref(false);
    const expandedOrders = ref(new Set());
    const editForm = ref({
      name: '',
      email: '',
    });
    
    const editingEmailForTicket = ref(null);
    const emailEditValue = ref('');
    const emailJustChanged = ref(new Set());

    const filteredTickets = computed(() => {
      let filtered = tickets.value;
      
      if (showNoEmailOnly.value) {
        filtered = filtered.filter(t => !t.email || t.email.trim() === '');
      }
      
      if (filterEventId.value !== 'all') {
        filtered = filtered.filter(t => t.event_id === filterEventId.value);
      }
      
      if (searchQuery.value.trim()) {
        const query = searchQuery.value.toLowerCase().trim();
        filtered = filtered.filter(ticket => {
          return (
            ticket.name?.toLowerCase().includes(query) ||
            ticket.email?.toLowerCase().includes(query) ||
            ticket.shopify_order_id?.toLowerCase().includes(query) ||
            ticket.uuid?.toLowerCase().includes(query)
          );
        });
      }
      
      return filtered;
    });

    const groupedTickets = computed(() => {
      const groups = {};

      filteredTickets.value.forEach(ticket => {
        const orderId = ticket.shopify_order_id || ('manual-' + ticket.id);
        if (!groups[orderId]) {
          groups[orderId] = {
            orderId,
            isShopifyOrder: !!ticket.shopify_order_id,
            tickets: [],
            customerName: ticket.name,
            customerEmail: ticket.email
          };
        }
        groups[orderId].tickets.push(ticket);
      });

      // Hide orders whose tickets are ALL from archived events.
      // Mixed orders (some archived, some not) stay visible — archived
      // ticket rows will be greyed out via the .archived-row CSS class.
      const visible = Object.values(groups).filter(group =>
        group.tickets.some(t => !t.event_archived)
      );

      return visible.sort((a, b) => {
        const aDate = new Date(a.tickets[0].created_at);
        const bDate = new Date(b.tickets[0].created_at);
        return bDate - aDate;
      });
    });

    // Count tickets that are actually rendered (excludes tickets in
    // fully-archived orders that we hide above).
    const visibleTicketCount = computed(() =>
      groupedTickets.value.reduce((sum, g) => sum + g.tickets.length, 0)
    );

    const toggleOrder = (orderId) => {
      if (expandedOrders.value.has(orderId)) {
        expandedOrders.value.delete(orderId);
      } else {
        expandedOrders.value.add(orderId);
      }
    };

    const isOrderExpanded = (orderId) => {
      return expandedOrders.value.has(orderId);
    };

    const loadTickets = async () => {
      loading.value = true;
      error.value = '';
      
      try {
        const response = await axios.get('/api/tickets');
        tickets.value = response.data.tickets || response.data;
      } catch (err) {
        console.error('Error loading tickets:', err);
        error.value = 'Failed to load tickets. Please try again.';
      } finally {
        loading.value = false;
      }
    };

    const loadEvents = async () => {
      try {
        const response = await axios.get('/api/events');
        events.value = response.data;
      } catch (err) {
        console.error('Error loading events:', err);
      }
    };

    const deleteTicket = async (id) => {
      if (!confirm('Are you sure you want to delete this ticket?')) {
        return;
      }

      try {
        await axios.delete('/api/tickets/' + id);
        tickets.value = tickets.value.filter(t => t.id !== id);
      } catch (err) {
        console.error('Error deleting ticket:', err);
        alert('Failed to delete ticket. Please try again.');
      }
    };

    const updateTicketStatus = async (id, status) => {
      try {
        await axios.patch('/api/tickets/' + id + '/status', { status });
        
        const ticket = tickets.value.find(t => t.id === id);
        if (ticket) {
          ticket.status = status;
        }
      } catch (err) {
        console.error('Error updating ticket status:', err);
        alert('Failed to update ticket status. Please try again.');
        loadTickets();
      }
    };

    const formatDate = (dateString) => {
      return new Date(dateString).toLocaleDateString();
    };

    const formatScanDate = (date) => {
      if (!date) return '';
      const d = new Date(date);
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return days[d.getDay()] + ', ' + months[d.getMonth()] + ' ' + d.getDate();
    };

    const goToAddTicket = () => {
      router.push('/add-ticket');
    };

    const openEditModal = (ticket) => {
      editingTicket.value = ticket;
      editForm.value = {
        name: ticket.name,
        email: ticket.email || '',
      };
    };

    const closeEditModal = () => {
      editingTicket.value = null;
      editForm.value = { name: '', email: '' };
    };

    const saveTicketEdits = async () => {
      saving.value = true;
      
      try {
        await axios.put('/api/tickets/' + editingTicket.value.id, editForm.value);
        
        const ticket = tickets.value.find(t => t.id === editingTicket.value.id);
        if (ticket) {
          ticket.name = editForm.value.name;
          ticket.email = editForm.value.email;
        }
        
        closeEditModal();
      } catch (err) {
        console.error('Error updating ticket:', err);
        alert('Failed to update ticket. Please try again.');
      } finally {
        saving.value = false;
      }
    };

    const toggleScanStatus = async (ticket) => {
      const action = ticket.scans?.scanned ? 'unmark' : 'mark';
      const confirmMsg = ticket.scans?.scanned 
        ? 'Mark this ticket as NOT scanned? This will remove the scan record.'
        : 'Mark this ticket as scanned?';
      
      if (!confirm(confirmMsg)) return;
      
      try {
        await axios.post('/api/tickets/' + ticket.id + '/scan-status', { action });
        await loadTickets();
      } catch (err) {
        console.error('Error toggling scan status:', err);
        alert('Failed to update scan status. Please try again.');
      }
    };

    const sendTicketEmail = async (ticketId) => {
      if (!confirm('Send the ticket email to this recipient?')) return;
      
      try {
        await axios.post('/api/tickets/' + ticketId + '/send-email');
        alert('Ticket email sent successfully!');
        emailJustChanged.value.delete(ticketId);
        await loadTickets();
      } catch (err) {
        console.error('Error sending ticket email:', err);
        alert('Failed to send ticket email. Please try again.');
      }
    };

    const sendAllTicketsEmail = async (group) => {
      const unsentCount = group.tickets.filter(t => !t.email_sent).length;
      if (!confirm('Send all ' + unsentCount + ' unsent ticket(s) in one email to ' + group.customerEmail + '?')) return;
      
      try {
        const ticketIds = group.tickets.filter(t => !t.email_sent).map(t => t.id);
        
        await axios.post('/api/tickets/send-order-email', { 
          ticketIds,
          customerName: group.customerName,
          customerEmail: group.customerEmail
        });
        
        alert('Email sent successfully!');
        await loadTickets();
      } catch (err) {
        console.error('Error sending order email:', err);
        alert('Failed to send order email. Please try again.');
      }
    };

    const showChangePassword = () => {
      isChangePasswordOpen.value = true;
    };

    const handleLogout = () => {
      authStore.logout();
      router.push('/login');
    };

    const startEmailEdit = (ticket) => {
      editingEmailForTicket.value = ticket.id;
      emailEditValue.value = ticket.email || '';
    };

    const cancelEmailEdit = () => {
      editingEmailForTicket.value = null;
      emailEditValue.value = '';
    };

    const saveEmail = async (ticket) => {
      try {
        const response = await axios.put('/api/tickets/' + ticket.id + '/email', {
          email: emailEditValue.value || null
        });
        
        if (response.data.showResendOption || (ticket.email === null && emailEditValue.value)) {
          emailJustChanged.value.add(ticket.id);
        }
        
        editingEmailForTicket.value = null;
        emailEditValue.value = '';
        
        await loadTickets();
      } catch (err) {
        console.error('Error updating email:', err);
        alert('Failed to update email');
      }
    };

    onMounted(() => {
      authStore.initAuth();
      loadTickets();
      loadEvents();
    });

    return {
      authStore,
      tickets,
      events,
      loading,
      error,
      isChangePasswordOpen,
      filterEventId,
      showNoEmailOnly,
      searchQuery,
      editingTicket,
      editForm,
      saving,
      filteredTickets,
      groupedTickets,
      visibleTicketCount,
      loadTickets,
      deleteTicket,
      updateTicketStatus,
      openEditModal,
      closeEditModal,
      saveTicketEdits,
      toggleScanStatus,
      sendTicketEmail,
      sendAllTicketsEmail,
      formatDate,
      formatScanDate,
      goToAddTicket,
      showChangePassword,
      handleLogout,
      toggleOrder,
      isOrderExpanded,
      editingEmailForTicket,
      emailEditValue,
      emailJustChanged,
      startEmailEdit,
      cancelEmailEdit,
      saveEmail,
    };
  },
};
</script>

<style scoped>
.tickets {
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

.nav-tab:hover { color: #667eea; }
.nav-tab.active { color: #667eea; border-bottom-color: #667eea; }

.filter-bar {
  display: flex;
  gap: 20px;
  align-items: center;
  margin-bottom: 16px;
  padding: 12px 16px;
  background: white;
  border-radius: 10px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.06);
}

.filter-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.filter-group label {
  font-weight: 500;
  color: #555;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.filter-select {
  padding: 8px 12px;
  border: 1px solid #ddd;
  border-radius: 8px;
  font-size: 0.9rem;
  min-width: 200px;
}

.search-bar {
  position: relative;
  margin-bottom: 16px;
}

.search-input {
  width: 100%;
  padding: 12px 16px 12px 40px;
  border: 1px solid #ddd;
  border-radius: 10px;
  font-size: 0.95rem;
  box-sizing: border-box;
}

.search-icon {
  position: absolute;
  left: 14px;
  top: 50%;
  transform: translateY(-50%);
  color: #999;
}

.actions-bar {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 20px;
}

.ticket-count-label {
  margin-left: auto;
  color: #888;
  font-size: 0.9rem;
}

.btn-primary {
  background: linear-gradient(135deg, #667eea, #764ba2);
  color: white;
  border: none;
  padding: 10px 20px;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 500;
}

.btn-primary:hover { opacity: 0.9; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-secondary {
  background: #e0e0e0;
  color: #333;
  border: none;
  padding: 10px 20px;
  border-radius: 8px;
  cursor: pointer;
}

.btn-secondary:hover { background: #d0d0d0; }

.tickets-table {
  background: white;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 2px 10px rgba(0,0,0,0.08);
}

table {
  width: 100%;
  border-collapse: collapse;
}

th {
  background: #f8f9fa;
  padding: 12px 16px;
  text-align: left;
  font-weight: 600;
  color: #555;
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-bottom: 2px solid #e0e0e0;
}

td {
  padding: 12px 16px;
  border-bottom: 1px solid #f0f0f0;
  font-size: 0.9rem;
}

.order-row {
  cursor: pointer;
  background: #fafbfc;
}

.order-row:hover { background: #f0f2ff; }

.ticket-row {
  background: white;
}

.ticket-row:hover { background: #f8f9fa; }

.ticket-row.archived-row {
  background: #f5f5f5;
  color: #888;
}

.ticket-row.archived-row:hover { background: #eeeeee; }

.ticket-row.archived-row td {
  font-style: italic;
}

.ticket-row.archived-row .badge.event-badge {
  opacity: 0.65;
}

.archived-event-badge {
  background: #eceff1;
  color: #546e7a;
  font-size: 0.7rem;
  margin-left: 6px;
  font-style: normal;
}

.order-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.expand-icon {
  color: #999;
  font-size: 0.8rem;
}

.order-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 0.75rem;
  background: #e8f5e9;
  color: #2e7d32;
}

.order-badge.manual {
  background: #fff3e0;
  color: #e65100;
}

.badge {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 0.8rem;
  font-weight: 500;
}

.event-badge {
  background: #e8eaf6;
  color: #3949ab;
}

.email-edit-container {
  display: flex;
  align-items: center;
  gap: 4px;
}

.email-edit-input {
  padding: 4px 8px;
  border: 1px solid #667eea;
  border-radius: 4px;
  font-size: 0.85rem;
  width: 180px;
}

.btn-save-small, .btn-cancel-small {
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px;
  font-size: 0.9rem;
}

.btn-save-small { color: #4CAF50; }
.btn-cancel-small { color: #f44336; }

.email-display {
  display: flex;
  align-items: center;
  gap: 6px;
}

.btn-edit-small {
  background: none;
  border: none;
  cursor: pointer;
  color: #999;
  padding: 2px;
  font-size: 0.75rem;
}

.btn-edit-small:hover { color: #667eea; }

.scan-status .scanned {
  color: #4CAF50;
  font-size: 0.85rem;
}

.scan-status .not-scanned {
  color: #999;
  font-size: 0.85rem;
}

.check-icon { margin-right: 4px; }

.scanner-info {
  font-size: 0.75rem;
  color: #888;
}

.email-status-cell {
  display: flex;
  align-items: center;
  gap: 6px;
}

.email-status-badge {
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 0.8rem;
  background: #ffebee;
  color: #c62828;
}

.email-status-badge.sent {
  background: #e8f5e9;
  color: #2e7d32;
}

.email-status-summary {
  font-size: 0.85rem;
  color: #666;
}

.status-select {
  padding: 4px 8px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 0.8rem;
}

.status-select.valid { color: #4CAF50; }
.status-select.invalid { color: #f44336; }
.status-select.refunded { color: #ff9800; }
.status-select.cancelled { color: #9e9e9e; }
.status-select.chargeback { color: #e91e63; }

.actions-cell {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.btn-edit {
  background: #e3f2fd;
  color: #1565c0;
  border: none;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.8rem;
}

.btn-send-email {
  background: #e8f5e9;
  color: #2e7d32;
  border: none;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.8rem;
}

.btn-send-email.email-changed {
  background: #fff3e0;
  color: #e65100;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

.btn-resend-email {
  background: none;
  border: none;
  color: #667eea;
  cursor: pointer;
  font-size: 0.75rem;
  display: flex;
  align-items: center;
  gap: 3px;
}

.btn-scan {
  background: #f3e5f5;
  color: #7b1fa2;
  border: none;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.8rem;
}

.btn-scan.scanned {
  background: #fce4ec;
  color: #c62828;
}

.btn-delete {
  background: #ffebee;
  color: #c62828;
  border: none;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.8rem;
}

.btn-send-all {
  background: #e8f5e9;
  color: #2e7d32;
  border: none;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.8rem;
}

.order-actions {
  display: flex;
  gap: 6px;
}

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

.empty-state {
  text-align: center;
  padding: 60px;
  background: white;
  border-radius: 12px;
  color: #888;
}

.modal-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 999;
}

.modal-content {
  background: white;
  border-radius: 12px;
  width: 90%;
  max-width: 500px;
  max-height: 90vh;
  overflow-y: auto;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid #eee;
}

.modal-header h2 { margin: 0; font-size: 1.2rem; }

.btn-close {
  background: none;
  border: none;
  font-size: 1.5rem;
  cursor: pointer;
  color: #666;
}

.modal-body {
  padding: 20px;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  margin-bottom: 6px;
  font-weight: 500;
  color: #333;
}

.form-group input,
.form-group select {
  width: 100%;
  padding: 10px;
  border: 1px solid #ddd;
  border-radius: 8px;
  font-size: 0.95rem;
  box-sizing: border-box;
}

.form-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 20px;
}
</style>
