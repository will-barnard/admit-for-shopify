# Optional Email Implementation Progress

## Completed Tasks ✅

### 1. Database Schema Update
- **File**: `backend/src/migrations/run.js`
- Made email column nullable in tickets table
- Migration will execute on next backend restart

### 2. Backend API Updates

#### Ticket Creation Endpoint (`backend/src/routes/tickets.js`)
- Updated POST `/create-order` to accept optional email (can be null)
- Modified email validation to be optional
- Updated email sending logic to skip when email is null
- Added proper messaging for tickets created without email

#### Email Update Endpoint (`backend/src/routes/tickets.js`)
- Created PUT `/:id/email` to update ticket email addresses
- Detects if email was previously sent and email changed
- Resets `email_sent` flag when email changes
- Returns `showResendOption` flag to frontend

#### Send Email Endpoint (`backend/src/routes/tickets.js`)
- Added check to prevent sending when ticket has no email
- Returns proper error message: "No email address on file for this ticket"

#### Batch Email Endpoint (`backend/src/routes/tickets.js`)
- Updated query to exclude tickets with `email IS NULL`
- Only attempts to send to tickets with valid emails

#### CSV Export Endpoint (`backend/src/routes/settings.js`)
- Created GET `/export-no-email-tickets` endpoint
- Exports CSV of all tickets without email addresses
- Includes all relevant fields: ID, Type, Subtype, Name, Teacher, Booth Range, Quantity, Order ID, Status, Scanned, Created At

### 3. Frontend - Create Ticket Form (`frontend/src/views/AddTicket.vue`)
- Added checkbox: "Include email address"
- Made email field conditional based on checkbox state
- Email field only required when checkbox is checked
- Sends `null` for email when checkbox is unchecked

## Remaining Tasks 🔧

### 4. Make Email Field Editable in Tickets View (`frontend/src/views/Tickets.vue`)

**What needs to be done:**
1. Convert email display from plain text to editable input field
2. Add "Edit" and "Save" buttons next to email field
3. Call PUT `/api/tickets/:id/email` endpoint when saving
4. Show "Send Email" button when:
   - Email is added to a ticket that had no email
   - Email is changed on a ticket where email was already sent
5. Handle both the ticket table view and the exhibitor modal

**Implementation approach:**
```vue
<!-- In ticket row -->
<td class="email-cell">
  <template v-if="editingEmailForTicket === ticket.id">
    <input 
      v-model="emailEditValue" 
      type="email"
      placeholder="Enter email (optional)"
      class="email-edit-input"
    />
    <button @click="saveEmail(ticket.id)" class="btn-save-email">Save</button>
    <button @click="cancelEmailEdit" class="btn-cancel">Cancel</button>
  </template>
  <template v-else>
    <span :class="{'no-email': !ticket.email}">
      {{ ticket.email || 'No email' }}
    </span>
    <button 
      v-if="authStore.user?.role === 'admin' || authStore.user?.role === 'superadmin'"
      @click="startEmailEdit(ticket)"
      class="btn-edit-email"
    >
      Edit
    </button>
  </template>
  <button 
    v-if="ticket.email && !ticket.email_sent && (authStore.user?.role === 'admin' || authStore.user?.role === 'superadmin')"
    @click="sendTicketEmail(ticket.id)"
    class="btn-send"
  >
    Send
  </button>
</td>
```

**Script additions needed:**
```javascript
const editingEmailForTicket = ref(null);
const emailEditValue = ref('');
const emailJustChanged = ref(new Set());

const startEmailEdit = (ticket) => {
  editingEmailForTicket.value = ticket.id;
  emailEditValue.value = ticket.email || '';
};

const cancelEmailEdit = () => {
  editingEmailForTicket.value = null;
  emailEditValue.value = '';
};

const saveEmail = async (ticketId) => {
  try {
    const response = await axios.put(`/api/tickets/${ticketId}/email`, {
      email: emailEditValue.value || null
    });
    
    // Update ticket in local state
    const ticket = findTicketById(ticketId);
    if (ticket) {
      const oldEmail = ticket.email;
      ticket.email = emailEditValue.value || null;
      
      // Track if email changed and needs resend
      if (response.data.showResendOption) {
        emailJustChanged.value.add(ticketId);
        ticket.email_sent = false;
      } else if (oldEmail === null && emailEditValue.value) {
        // Email was added to previously null email
        emailJustChanged.value.add(ticketId);
      }
    }
    
    editingEmailForTicket.value = null;
    emailEditValue.value = '';
    
    await loadTickets(); // Refresh
  } catch (error) {
    console.error('Error updating email:', error);
    alert('Failed to update email');
  }
};
```

### 5. Add No-Email Filter to Tickets Page (`frontend/src/views/Tickets.vue`)

**What needs to be done:**
1. Add a filter button/toggle for "No Email" tickets
2. Update the filtering logic to show only tickets without emails when selected
3. Display count of tickets without emails

**Implementation approach:**
```vue
<!-- Add to ticket-type-tabs section -->
<button
  @click="filterType = 'no-email'"
  :class="['type-tab', { active: filterType === 'no-email' }]"
>
  <font-awesome-icon icon="envelope-open" />
  No Email ({{ noEmailTickets }})
</button>
```

**Script additions:**
```javascript
const noEmailTickets = computed(() => {
  return tickets.value.filter(t => !t.email).length;
});

// Update filteredTickets computed property
const filteredTickets = computed(() => {
  let filtered = tickets.value;
  
  if (filterType.value === 'no-email') {
    filtered = filtered.filter(t => !t.email);
  } else {
    filtered = filtered.filter(t => t.ticket_type === filterType.value);
  }
  
  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase();
    filtered = filtered.filter(t => 
      t.name.toLowerCase().includes(query) ||
      (t.email && t.email.toLowerCase().includes(query)) ||
      // ... other search fields
    );
  }
  
  return filtered;
});
```

### 6. Add Export Button to Settings Page (`frontend/src/views/Settings.vue`)

**What needs to be done:**
1. Add button to download CSV of tickets without emails
2. Call GET `/api/settings/export-no-email-tickets` endpoint
3. Handle the file download

**Implementation approach:**
```vue
<div class="settings-card">
  <h3>Export Options</h3>
  <div class="export-actions">
    <button @click="exportNoEmailTickets" class="btn-secondary">
      <font-awesome-icon icon="file-csv" />
      Export Tickets Without Email
    </button>
  </div>
</div>
```

**Script additions:**
```javascript
const exportNoEmailTickets = async () => {
  try {
    const response = await axios.get('/api/settings/export-no-email-tickets', {
      responseType: 'blob'
    });
    
    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `no-email-tickets-${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Error exporting no-email tickets:', error);
    if (error.response?.status === 404) {
      alert('No tickets without email found');
    } else {
      alert('Failed to export tickets');
    }
  }
};
```

## Testing Checklist

### Backend
- [ ] Run migrations to make email nullable
- [ ] Test creating ticket with email
- [ ] Test creating ticket without email (checkbox unchecked)
- [ ] Test updating ticket email from null to valid email
- [ ] Test updating ticket email from valid to different valid email
- [ ] Test updating ticket email from valid to null
- [ ] Test sending email to ticket without email (should fail gracefully)
- [ ] Test batch email send (should skip tickets without emails)
- [ ] Test CSV export of no-email tickets

### Frontend
- [ ] Create ticket form shows email checkbox
- [ ] Creating ticket without email works
- [ ] Email field is editable in tickets view
- [ ] Saving email updates the display
- [ ] Send button appears when email is added
- [ ] Send button appears when email is changed after being sent
- [ ] No-email filter shows correct tickets
- [ ] Export button downloads CSV correctly
- [ ] All email fields handle null gracefully

## Notes for Completion

1. **UI/UX Considerations:**
   - Make "no email" state visually distinct (grayed out text, different icon)
   - Provide clear feedback when email is saved
   - Show confirmation when sending email after email change
   - Consider adding tooltip explaining why send button appears

2. **Edge Cases to Handle:**
   - Bulk operations on tickets with mixed email states
   - Exhibitor modal email editing
   - Email validation (format checking)
   - Concurrent edits from multiple admins

3. **Security:**
   - Ensure only admin/superadmin can edit emails
   - Validate email format on both frontend and backend
   - Sanitize email input to prevent injection

4. **Performance:**
   - Consider debouncing email edits
   - Batch email validations
   - Optimize queries for no-email filter

## Files Modified So Far

### Backend
- `backend/src/migrations/run.js` - Made email nullable
- `backend/src/routes/tickets.js` - Updated creation, validation, email update endpoint, batch send
- `backend/src/routes/settings.js` - Added CSV export endpoint

### Frontend
- `frontend/src/views/AddTicket.vue` - Added email checkbox

### Files Still Needing Updates
- `frontend/src/views/Tickets.vue` - Email editing, no-email filter
- `frontend/src/views/Settings.vue` - Export button
