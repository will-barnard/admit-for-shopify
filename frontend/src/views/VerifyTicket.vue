<template>
  <div class="verify-container">
    <div v-if="loading" class="verify-card">
      <div class="loading-spinner"></div>
      <h2>Verifying ticket...</h2>
    </div>

    <div v-else-if="status === 'valid'" class="verify-card success">
      <div class="checkmark">
        <svg viewBox="0 0 52 52">
          <circle cx="26" cy="26" r="25" fill="none"/>
          <path fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8"/>
        </svg>
      </div>
      <h1>Access Granted!</h1>
      <h2>Welcome</h2>
      <div class="ticket-info">
        <p><strong>Event:</strong> {{ ticketData.eventName }}</p>
        <p><strong>Name:</strong> {{ ticketData.name }}</p>
        <p v-if="ticketData.eventDate"><strong>Date:</strong> {{ ticketData.eventDate }}</p>
        <p v-if="ticketData.location"><strong>Location:</strong> {{ ticketData.location }}</p>
      </div>
      <p class="message">This ticket has been marked as used.</p>
    </div>

    <div v-else-if="status === 'already_used'" class="verify-card warning">
      <div class="icon">⚠️</div>
      <h1>Ticket Already Used</h1>
      <div class="ticket-info">
        <p><strong>Name:</strong> {{ ticketData.name }}</p>
      </div>
      <p class="message">This ticket has already been scanned and used.</p>
    </div>

    <div v-else-if="status === 'invalid'" class="verify-card error">
      <div class="icon">❌</div>
      <h1>Invalid Ticket</h1>
      <p class="message">This ticket could not be found in our system.</p>
    </div>

    <div v-else class="verify-card error">
      <div class="icon">❌</div>
      <h1>Error</h1>
      <p class="message">An error occurred while verifying the ticket.</p>
    </div>
  </div>
</template>

<script>
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import axios from 'axios';

export default {
  name: 'VerifyTicket',
  setup() {
    const route = useRoute();
    
    const loading = ref(true);
    const status = ref('');
    const ticketData = ref({
      eventName: '',
      eventDate: '',
      location: '',
      name: '',
    });

    const verifyTicket = async () => {
      const uuid = route.params.uuid;
      
      try {
        const response = await axios.get(`/api/verify/${uuid}`);
        status.value = response.data.status;
        
        if (response.data.name) {
          ticketData.value.eventName = response.data.eventName || '';
          ticketData.value.eventDate = response.data.eventDate || '';
          ticketData.value.location = response.data.location || '';
          ticketData.value.name = response.data.name;
        }
      } catch (error) {
        if (error.response?.data?.status) {
          status.value = error.response.data.status;
          if (error.response.data.name) {
            ticketData.value.name = error.response.data.name;
            ticketData.value.eventName = error.response.data.eventName || '';
          }
        } else {
          status.value = 'error';
        }
      } finally {
        loading.value = false;
      }
    };

    onMounted(() => {
      verifyTicket();
    });

    return {
      loading,
      status,
      ticketData,
    };
  },
};
</script>

<style scoped>
.verify-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  padding: 20px;
}

.verify-card {
  background: white;
  padding: 60px 40px;
  border-radius: 20px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
  text-align: center;
  max-width: 500px;
  width: 100%;
}

.loading-spinner {
  border: 4px solid #f3f3f3;
  border-top: 4px solid #667eea;
  border-radius: 50%;
  width: 50px;
  height: 50px;
  animation: spin 1s linear infinite;
  margin: 0 auto 20px;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.checkmark {
  width: 100px;
  height: 100px;
  margin: 0 auto 20px;
}

.checkmark svg {
  width: 100%;
  height: 100%;
}

.success .checkmark circle {
  stroke: #4CAF50;
  stroke-width: 2;
  stroke-dasharray: 166;
  stroke-dashoffset: 166;
  animation: stroke 0.6s cubic-bezier(0.65, 0, 0.45, 1) forwards;
}

.success .checkmark path {
  stroke: #4CAF50;
  stroke-width: 3;
  stroke-dasharray: 48;
  stroke-dashoffset: 48;
  animation: stroke 0.3s cubic-bezier(0.65, 0, 0.45, 1) 0.6s forwards;
}

@keyframes stroke {
  100% {
    stroke-dashoffset: 0;
  }
}

.icon {
  font-size: 80px;
  margin-bottom: 20px;
}

h1 {
  color: #333;
  font-size: 32px;
  margin-bottom: 10px;
}

h2 {
  color: #666;
  font-size: 20px;
  margin-bottom: 30px;
  font-weight: normal;
}

.ticket-info {
  background: #f8f9fa;
  padding: 20px;
  border-radius: 10px;
  margin: 30px 0;
}

.ticket-info p {
  margin: 10px 0;
  font-size: 18px;
  color: #333;
}

.message {
  color: #666;
  font-size: 16px;
  margin-top: 20px;
}

.success {
  border-top: 5px solid #4CAF50;
}

.warning {
  border-top: 5px solid #ff9800;
}

.error {
  border-top: 5px solid #f44336;
}
</style>
