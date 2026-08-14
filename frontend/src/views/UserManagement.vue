<template>
  <div class="user-management">
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
        <h1>👥 User Management</h1>
        <p class="page-description">Create and manage admin and scanner accounts</p>

        <!-- Create New User -->
        <div class="card create-user-section">
          <h2>Create New User</h2>
          <form @submit.prevent="createUser" class="create-user-form">
            <div class="form-row">
              <div class="form-group">
                <label for="newUsername">Username</label>
                <input
                  type="text"
                  id="newUsername"
                  v-model="newUser.username"
                  required
                  placeholder="Enter username"
                />
              </div>
              
              <div class="form-group">
                <label for="newPassword">Password</label>
                <input
                  type="password"
                  id="newPassword"
                  v-model="newUser.password"
                  required
                  minlength="6"
                  placeholder="Minimum 6 characters"
                />
              </div>
              
              <div class="form-group">
                <label for="newRole">Role</label>
                <select id="newRole" v-model="newUser.role" required>
                  <option value="admin">Admin</option>
                  <option value="verifier">Scanner/Verifier</option>
                </select>
              </div>
            </div>
            
            <button type="submit" class="btn-create" :disabled="creatingUser">
              {{ creatingUser ? 'Creating...' : 'Create User' }}
            </button>
          </form>
          
          <div v-if="userMessage" :class="['user-message', userMessageType]">
            {{ userMessage }}
          </div>
        </div>

        <!-- List of Users -->
        <div class="card users-list-section">
          <h2>Existing Users</h2>
          <div v-if="loadingUsers" class="loading">Loading users...</div>
          <div v-else-if="users.length === 0" class="no-users">No users found</div>
          <table v-else class="users-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Role</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="user in users" :key="user.id">
                <td>{{ user.username }}</td>
                <td>
                  <span class="role-badge" :class="user.role">
                    {{ formatRole(user.role) }}
                  </span>
                </td>
                <td>{{ formatDate(user.created_at) }}</td>
                <td>
                  <button
                    v-if="user.role !== 'superadmin' && user.id !== authStore.user.id"
                    @click="confirmDeleteUser(user)"
                    class="btn-delete-user"
                    :disabled="deletingUserId === user.id"
                  >
                    {{ deletingUserId === user.id ? 'Deleting...' : 'Delete' }}
                  </button>
                  <span v-else class="no-action">-</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
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
  name: 'UserManagement',
  components: {
    ChangePasswordModal,
    PageHeader,
  },
  setup() {
    const router = useRouter();
    const authStore = useAuthStore();
    const isChangePasswordOpen = ref(false);

    const users = ref([]);
    const loadingUsers = ref(false);
    const creatingUser = ref(false);
    const deletingUserId = ref(null);
    const userMessage = ref('');
    const userMessageType = ref('');
    const newUser = ref({
      username: '',
      password: '',
      role: 'admin'
    });

    const fetchUsers = async () => {
      loadingUsers.value = true;
      try {
        const response = await axios.get('/api/user/all');
        users.value = response.data.users;
      } catch (error) {
        console.error('Error fetching users:', error);
        userMessage.value = 'Failed to load users';
        userMessageType.value = 'error';
      } finally {
        loadingUsers.value = false;
      }
    };

    const createUser = async () => {
      creatingUser.value = true;
      userMessage.value = '';

      try {
        const response = await axios.post('/api/user/create', newUser.value);
        userMessage.value = `User "${newUser.value.username}" created successfully!`;
        userMessageType.value = 'success';
        
        // Reset form
        newUser.value = {
          username: '',
          password: '',
          role: 'admin'
        };
        
        // Reload users list
        await fetchUsers();
        
        // Clear message after 5 seconds
        setTimeout(() => {
          userMessage.value = '';
        }, 5000);
      } catch (error) {
        console.error('Error creating user:', error);
        userMessage.value = error.response?.data?.error || 'Failed to create user';
        userMessageType.value = 'error';
      } finally {
        creatingUser.value = false;
      }
    };

    const confirmDeleteUser = async (user) => {
      if (confirm(`Are you sure you want to delete user "${user.username}"? This action cannot be undone.`)) {
        await deleteUser(user.id);
      }
    };

    const deleteUser = async (userId) => {
      deletingUserId.value = userId;
      userMessage.value = '';

      try {
        await axios.delete(`/api/user/${userId}`);
        userMessage.value = 'User deleted successfully';
        userMessageType.value = 'success';
        
        // Reload users list
        await fetchUsers();
        
        // Clear message after 5 seconds
        setTimeout(() => {
          userMessage.value = '';
        }, 5000);
      } catch (error) {
        console.error('Error deleting user:', error);
        userMessage.value = error.response?.data?.error || 'Failed to delete user';
        userMessageType.value = 'error';
      } finally {
        deletingUserId.value = null;
      }
    };

    const formatRole = (role) => {
      const roles = {
        admin: 'Admin',
        verifier: 'Scanner/Verifier',
        superadmin: 'SuperAdmin'
      };
      return roles[role] || role;
    };

    const formatDate = (date) => {
      if (!date) return '-';
      return new Date(date).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
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
      
      fetchUsers();
    });

    return {
      authStore,
      users,
      loadingUsers,
      creatingUser,
      deletingUserId,
      userMessage,
      userMessageType,
      newUser,
      isChangePasswordOpen,
      createUser,
      confirmDeleteUser,
      formatRole,
      formatDate,
      showChangePassword,
      handleLogout,
    };
  },
};
</script>

<style scoped>
.user-management {
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

.card {
  background: white;
  padding: 30px;
  border-radius: 12px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  margin-bottom: 30px;
}

.card h2 {
  margin-top: 0;
  margin-bottom: 1.5rem;
  color: #333;
  font-size: 1.5rem;
}

/* Create User Section */
.create-user-form {
  margin-top: 1rem;
}

.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 1rem;
  margin-bottom: 1rem;
}

.form-group {
  display: flex;
  flex-direction: column;
}

.form-group label {
  margin-bottom: 0.5rem;
  font-weight: 500;
  color: #333;
}

.form-group input,
.form-group select {
  padding: 0.75rem;
  border: 1px solid #ddd;
  border-radius: 8px;
  font-size: 1rem;
}

.form-group input:focus,
.form-group select:focus {
  outline: none;
  border-color: #667eea;
}

.btn-create {
  background: #28a745;
  color: white;
  border: none;
  padding: 0.75rem 2rem;
  border-radius: 8px;
  cursor: pointer;
  font-size: 1rem;
  font-weight: 500;
  transition: background 0.2s;
}

.btn-create:hover:not(:disabled) {
  background: #218838;
}

.btn-create:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.user-message {
  margin-top: 1rem;
  padding: 1rem;
  border-radius: 8px;
  text-align: center;
  font-weight: 500;
}

.user-message.success {
  background: #d4edda;
  color: #155724;
  border: 1px solid #c3e6cb;
}

.user-message.error {
  background: #f8d7da;
  color: #721c24;
  border: 1px solid #f5c6cb;
}

/* Users List Section */
.loading,
.no-users {
  padding: 2rem;
  text-align: center;
  color: #666;
}

.users-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 1rem;
}

.users-table th,
.users-table td {
  padding: 1rem;
  text-align: left;
  border-bottom: 1px solid #e0e0e0;
}

.users-table th {
  background: #f5f5f5;
  font-weight: 600;
  color: #333;
}

.users-table tr:hover {
  background: #f9f9f9;
}

.role-badge {
  display: inline-block;
  padding: 0.25rem 0.75rem;
  border-radius: 12px;
  font-size: 0.875rem;
  font-weight: 500;
}

.role-badge.admin {
  background: #667eea;
  color: white;
}

.role-badge.verifier {
  background: #28a745;
  color: white;
}

.role-badge.superadmin {
  background: #ff9800;
  color: white;
}

.btn-delete-user {
  background: #dc3545;
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.875rem;
  transition: background 0.2s;
}

.btn-delete-user:hover:not(:disabled) {
  background: #c82333;
}

.btn-delete-user:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.no-action {
  color: #999;
}

@media (max-width: 768px) {
  .form-row {
    grid-template-columns: 1fr;
  }

  .nav-tabs {
    flex-wrap: wrap;
  }

  .nav-tab {
    padding: 10px 16px;
    font-size: 14px;
  }
}
</style>
