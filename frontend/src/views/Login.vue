<template>
  <div class="login-container">
    <div class="login-card">
      <div v-if="logoUrl" class="logo-container">
        <img :src="logoUrl" alt="Convention Logo" class="convention-logo" />
      </div>
      <h1>{{ conventionName }}</h1>
      <p class="subtitle">Event Ticket Manager</p>
      <h2>{{ isRegisterMode ? 'Register' : 'Login' }}</h2>
      
      <form @submit.prevent="handleSubmit">
        <div class="form-group">
          <label for="username">Username</label>
          <input
            id="username"
            v-model="username"
            type="text"
            required
            autocomplete="username"
          />
        </div>

        <div class="form-group">
          <label for="password">Password</label>
          <input
            id="password"
            v-model="password"
            type="password"
            required
            autocomplete="current-password"
          />
        </div>

        <div v-if="error" class="error-message">
          {{ error }}
        </div>

        <button type="submit" class="btn-primary">
          {{ isRegisterMode ? 'Register' : 'Login' }}
        </button>
      </form>

      <p class="toggle-mode">
        {{ isRegisterMode ? 'Already have an account?' : "Don't have an account?" }}
        <a href="#" @click.prevent="toggleMode">
          {{ isRegisterMode ? 'Login' : 'Register' }}
        </a>
      </p>
    </div>
  </div>
</template>

<script>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import axios from 'axios';

export default {
  name: 'Login',
  setup() {
    const router = useRouter();
    const authStore = useAuthStore();

    const username = ref('');
    const password = ref('');
    const error = ref('');
    const isRegisterMode = ref(false);
    const logoUrl = ref(null);
    const conventionName = ref('Event Ticket Manager');

    const fetchSettings = async () => {
      try {
        const response = await axios.get('/api/settings');
        if (response.data.logo_url) {
          logoUrl.value = response.data.logo_url;
        }
        if (response.data.org_name) {
          conventionName.value = response.data.org_name;
        }
      } catch (error) {
        console.log('Could not fetch settings');
      }
    };

    const handleSubmit = async () => {
      error.value = '';
      
      try {
        if (isRegisterMode.value) {
          await authStore.register(username.value, password.value);
        } else {
          await authStore.login(username.value, password.value);
        }
        router.push('/');
      } catch (err) {
        error.value = err.response?.data?.error || 'An error occurred';
      }
    };

    const toggleMode = () => {
      isRegisterMode.value = !isRegisterMode.value;
      error.value = '';
    };

    onMounted(() => {
      fetchSettings();
    });

    return {
      username,
      password,
      error,
      isRegisterMode,
      logoUrl,
      conventionName,
      handleSubmit,
      toggleMode,
    };
  },
};
</script>

<style scoped>
.login-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}

.login-card {
  background: white;
  padding: 40px;
  border-radius: 10px;
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
  width: 100%;
  max-width: 400px;
}

h1 {
  color: #333;
  margin-bottom: 5px;
  font-size: 24px;
  text-align: center;
}

.subtitle {
  color: #666;
  font-size: 14px;
  margin: 0 0 10px 0;
  text-align: center;
}

h2 {
  color: #666;
  margin-bottom: 30px;
  font-size: 20px;
  text-align: center;
}

.form-group {
  margin-bottom: 20px;
}

label {
  display: block;
  margin-bottom: 5px;
  color: #333;
  font-weight: 500;
}

input {
  width: 100%;
  padding: 10px;
  border: 1px solid #ddd;
  border-radius: 5px;
  font-size: 16px;
  box-sizing: border-box;
}

input:focus {
  outline: none;
  border-color: #667eea;
}

.error-message {
  background: #fee;
  color: #c33;
  padding: 10px;
  border-radius: 5px;
  margin-bottom: 20px;
}

.toggle-mode {
  text-align: center;
  margin-top: 20px;
  color: #666;
}

.toggle-mode a {
  color: #667eea;
  text-decoration: none;
  font-weight: 500;
}

.toggle-mode a:hover {
  text-decoration: underline;
}

.logo-container {
  text-align: center;
  margin-bottom: 20px;
  width: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
}

.convention-logo {
  max-width: 100%;
  max-height: 120px;
  width: auto;
  height: auto;
  object-fit: contain;
  display: block;
}

@media (max-width: 768px) {
  .login-container {
    padding: 20px;
  }

  .login-card {
    padding: 30px 20px;
  }

  .logo {
    max-width: 120px;
    max-height: 80px;
  }

  h1 {
    font-size: 24px;
  }

  .tagline {
    font-size: 13px;
  }

  .form-group label {
    font-size: 13px;
  }

  .form-group input {
    font-size: 14px;
    padding: 10px;
  }

  .btn-login {
    padding: 12px;
    font-size: 15px;
  }

  .toggle-mode {
    font-size: 13px;
  }
}

@media (max-width: 480px) {
  .login-container {
    padding: 15px;
  }

  .login-card {
    padding: 25px 15px;
  }

  h1 {
    font-size: 22px;
  }

  .convention-logo {
    max-height: 80px;
  }
}
</style>
