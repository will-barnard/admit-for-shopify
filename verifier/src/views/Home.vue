<template>
  <div class="home">
    <header class="header">
      <h1>Ticket Scanner</h1>
      <button @click="handleLogout" class="btn-logout">Logout</button>
    </header>

    <div class="container">
      <div class="welcome-card">
        <div class="welcome-icon">✓</div>
        <h2>Welcome, {{ authStore.user?.username || 'Verifier' }}</h2>
        <p>Ready to scan tickets</p>
      </div>

      <button @click="goToScanner" class="btn-scan">
        <span class="scan-icon">📷</span>
        <span class="scan-text">Scan Ticket QR Code</span>
      </button>

      <div class="info-card">
        <h3>How to use:</h3>
        <ol>
          <li>Click the "Scan Ticket QR Code" button</li>
          <li>Allow camera access when prompted</li>
          <li>Point your camera at the ticket QR code</li>
          <li>The ticket will be automatically verified</li>
        </ol>
      </div>
    </div>
  </div>
</template>

<script>
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

export default {
  name: 'Home',
  setup() {
    const router = useRouter();
    const authStore = useAuthStore();

    const goToScanner = () => {
      router.push('/scanner');
    };

    const handleLogout = () => {
      authStore.logout();
      router.push('/login');
    };

    return {
      authStore,
      goToScanner,
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

.header {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  padding: 20px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
}

.header h1 {
  margin: 0;
  font-size: 24px;
}

.btn-logout {
  background: rgba(255, 255, 255, 0.2);
  color: white;
  border: 1px solid rgba(255, 255, 255, 0.5);
  padding: 10px 20px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  transition: background 0.2s;
}

.btn-logout:hover {
  background: rgba(255, 255, 255, 0.3);
}

.container {
  max-width: 600px;
  margin: 0 auto;
  padding: 30px 20px;
}

.welcome-card {
  background: white;
  border-radius: 15px;
  padding: 40px;
  text-align: center;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
  margin-bottom: 30px;
}

.welcome-icon {
  width: 80px;
  height: 80px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 40px;
  color: white;
  margin: 0 auto 20px;
  font-weight: bold;
}

.welcome-card h2 {
  margin: 0 0 10px 0;
  color: #333;
  font-size: 24px;
}

.welcome-card p {
  margin: 0;
  color: #666;
  font-size: 16px;
}

.btn-scan {
  width: 100%;
  padding: 30px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border: none;
  border-radius: 15px;
  font-size: 20px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 15px;
  box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
  transition: transform 0.2s, box-shadow 0.2s;
  margin-bottom: 30px;
}

.btn-scan:hover {
  transform: translateY(-3px);
  box-shadow: 0 6px 20px rgba(102, 126, 234, 0.5);
}

.scan-icon {
  font-size: 32px;
}

.scan-text {
  font-size: 18px;
}

.info-card {
  background: white;
  border-radius: 15px;
  padding: 30px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
}

.info-card h3 {
  margin: 0 0 20px 0;
  color: #333;
  font-size: 18px;
}

.info-card ol {
  margin: 0;
  padding-left: 20px;
  color: #666;
  line-height: 1.8;
}

.info-card li {
  margin-bottom: 10px;
}
</style>
