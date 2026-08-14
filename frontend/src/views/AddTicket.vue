<template>
  <div class="add-ticket">
    <header class="header">
      <h1>Create Ticket Order</h1>
      <button @click="goBack" class="btn-secondary">Back to Tickets</button>
    </header>

    <div class="container">
      <div class="form-card">
        <h2>Order Information</h2>
        <form @submit.prevent="handleSubmit">
          
          <div class="form-group">
            <label for="customerName">Customer Name *</label>
            <input
              id="customerName"
              v-model="orderData.customerName"
              type="text"
              required
              placeholder="Enter customer name"
            />
          </div>

          <div class="form-group">
            <div class="checkbox-wrapper">
              <input
                id="includeEmail"
                v-model="includeEmail"
                type="checkbox"
                checked
              />
              <label for="includeEmail">Include email address</label>
            </div>
          </div>

          <div v-if="includeEmail" class="form-group">
            <label for="email">Email Address *</label>
            <input
              id="email"
              v-model="orderData.email"
              type="email"
              :required="includeEmail"
              placeholder="Enter email address"
            />
            <p class="hint">All tickets will be sent to this email</p>
          </div>

          <div class="tickets-section">
            <h3>Tickets in Order</h3>
            
            <div v-for="(ticket, index) in orderData.tickets" :key="index" class="ticket-line">
              <div class="ticket-line-header">
                <h4>Ticket {{ index + 1 }}</h4>
                <button
                  type="button"
                  @click="removeTicket(index)"
                  class="btn-remove-ticket"
                  :disabled="orderData.tickets.length === 1"
                  title="Remove ticket"
                >
                  ✕ Remove
                </button>
              </div>

              <div class="ticket-fields">
                <div class="form-group">
                  <label>Event *</label>
                  <select v-model="ticket.eventId" required>
                    <option value="">Select event</option>
                    <option v-for="event in events" :key="event.id" :value="event.id">{{ event.name }}</option>
                  </select>
                </div>

                <div class="form-group">
                  <label>Attendee Name *</label>
                  <input
                    v-model="ticket.name"
                    type="text"
                    required
                    placeholder="Attendee name"
                  />
                </div>

                <div class="form-group">
                  <label>Quantity *</label>
                  <input
                    v-model.number="ticket.quantity"
                    type="number"
                    min="1"
                    max="50"
                    required
                  />
                </div>
              </div>
            </div>

            <button
              type="button"
              @click="addTicket"
              class="btn-add-ticket"
            >
              + Add Another Ticket
            </button>
          </div>

          <div v-if="error" class="error-message">
            {{ error }}
          </div>

          <div v-if="success" class="success-message">
            {{ success }}
          </div>

          <div class="form-actions">
            <button
              type="submit"
              class="btn-primary"
              :disabled="loading"
            >
              {{ loading ? 'Creating Order...' : 'Create Order (' + totalTickets + ' ticket' + (totalTickets > 1 ? 's' : '') + ')' }}
            </button>
            <button
              type="button"
              @click="resetForm"
              class="btn-secondary"
              :disabled="loading"
            >
              Clear Form
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, reactive, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import axios from 'axios';
import { useAuthStore } from '@/stores/auth';

export default {
  name: 'AddTicket',
  setup() {
    const router = useRouter();
    const authStore = useAuthStore();
    const events = ref([]);

    const orderData = reactive({
      customerName: '',
      email: '',
      tickets: [{
        eventId: '',
        name: '',
        quantity: 1,
      }]
    });

    const loading = ref(false);
    const error = ref('');
    const success = ref('');
    const includeEmail = ref(true);

    const totalTickets = computed(() => {
      return orderData.tickets.reduce((sum, ticket) => sum + (ticket.quantity || 0), 0);
    });

    const loadEvents = async () => {
      try {
        const response = await axios.get('/api/events/list/active');
        events.value = response.data;
      } catch (err) {
        console.error('Error loading events:', err);
      }
    };

    const addTicket = () => {
      orderData.tickets.push({
        eventId: '',
        name: '',
        quantity: 1,
      });
    };

    const removeTicket = (index) => {
      if (orderData.tickets.length > 1) {
        orderData.tickets.splice(index, 1);
      }
    };

    const handleSubmit = async () => {
      loading.value = true;
      error.value = '';
      success.value = '';

      try {
        const payload = {
          customerName: orderData.customerName,
          email: includeEmail.value ? orderData.email : null,
          tickets: orderData.tickets.map(ticket => ({
            eventId: ticket.eventId,
            name: ticket.name,
            quantity: ticket.quantity
          }))
        };

        const response = await axios.post('/api/tickets/create-order', payload);
        
        const ticketCount = response.data.ticketCount || totalTickets.value;
        if (response.data.warning) {
          success.value = 'Order created with ' + ticketCount + ' ticket(s), but email delivery failed. Please check email configuration.';
        } else {
          success.value = 'Order created successfully with ' + ticketCount + ' ticket(s)!';
        }

        setTimeout(() => {
          resetForm();
          router.push('/tickets');
        }, 2000);
      } catch (err) {
        error.value = err.response?.data?.error || 'Failed to create order';
        console.error('Error creating order:', err);
      } finally {
        loading.value = false;
      }
    };

    const resetForm = () => {
      orderData.customerName = '';
      orderData.email = '';
      orderData.tickets = [{
        eventId: '',
        name: '',
        quantity: 1,
      }];
      error.value = '';
      success.value = '';
    };

    const goBack = () => {
      router.push('/tickets');
    };

    onMounted(() => {
      loadEvents();
    });

    return {
      events,
      orderData,
      loading,
      error,
      success,
      includeEmail,
      totalTickets,
      handleSubmit,
      addTicket,
      removeTicket,
      resetForm,
      goBack,
    };
  },
};
</script>

<style scoped>
.add-ticket {
  min-height: 100vh;
  background: #f5f5f5;
}

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
  font-size: 24px;
}

.container {
  max-width: 900px;
  margin: 0 auto;
  padding: 40px 20px;
}

.form-card {
  background: white;
  padding: 40px;
  border-radius: 10px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.form-card h2 {
  margin: 0 0 30px 0;
  color: #333;
  font-size: 24px;
  padding-bottom: 15px;
  border-bottom: 2px solid #f0f0f0;
}

.form-group {
  margin-bottom: 25px;
}

label {
  display: block;
  margin-bottom: 8px;
  color: #333;
  font-weight: 500;
}

input, select {
  width: 100%;
  padding: 12px;
  border: 1px solid #ddd;
  border-radius: 5px;
  font-size: 16px;
  box-sizing: border-box;
  background-color: white;
}

input:focus, select:focus {
  outline: none;
  border-color: #667eea;
}

.tickets-section h3 {
  margin: 0 0 20px 0;
  color: #333;
  font-size: 20px;
}

.ticket-line {
  background: #f8f9fa;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 25px;
  margin-bottom: 20px;
}

.ticket-line-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.ticket-line-header h4 {
  margin: 0;
  color: #555;
  font-size: 16px;
  font-weight: 600;
}

.ticket-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 15px;
}

.ticket-fields .form-group {
  margin-bottom: 0;
}

.checkbox-wrapper {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 5px;
}

.checkbox-wrapper input[type="checkbox"] {
  width: auto;
  height: auto;
  cursor: pointer;
}

.checkbox-wrapper label {
  margin: 0;
  cursor: pointer;
  font-weight: 500;
}

.btn-remove-ticket {
  background: #dc3545;
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 14px;
  transition: background 0.2s;
}

.btn-remove-ticket:hover:not(:disabled) { background: #c82333; }
.btn-remove-ticket:disabled { background: #ccc; cursor: not-allowed; opacity: 0.5; }

.btn-add-ticket {
  background: #28a745;
  color: white;
  border: none;
  padding: 12px 24px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 16px;
  font-weight: 500;
  margin-bottom: 30px;
  transition: background 0.2s;
}

.btn-add-ticket:hover { background: #218838; }

.hint {
  margin: 5px 0 0 0;
  font-size: 13px;
  color: #666;
}

.error-message {
  background: #fee;
  color: #c33;
  padding: 12px;
  border-radius: 5px;
  margin-bottom: 20px;
}

.success-message {
  background: #d4edda;
  color: #155724;
  padding: 12px;
  border-radius: 5px;
  margin-bottom: 20px;
}

.form-actions {
  display: flex;
  gap: 10px;
  margin-top: 30px;
  padding-top: 30px;
  border-top: 2px solid #f0f0f0;
}

.form-actions button { flex: 1; }

.btn-primary {
  background: linear-gradient(135deg, #667eea, #764ba2);
  color: white;
  border: none;
  padding: 12px 24px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 16px;
  font-weight: 500;
}

.btn-primary:hover { opacity: 0.9; }

.btn-secondary {
  background: #e0e0e0;
  color: #333;
  border: none;
  padding: 12px 24px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 16px;
}

.btn-secondary:hover { background: #d0d0d0; }

button:disabled { opacity: 0.6; cursor: not-allowed; }

@media (max-width: 768px) {
  .container { padding: 15px; }
  .form-card { padding: 20px; }
  .ticket-fields { grid-template-columns: 1fr; }
  .form-actions { flex-direction: column; }
  .form-actions button { width: 100%; }
}
</style>
