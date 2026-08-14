# Convention Ticket Manager

A full-stack web application for managing convention tickets with QR code verification. Built with Node.js, Vue.js, PostgreSQL, and deployed using Docker Compose.

## Features

### Management Interface (Authentication Required)
- **Add Tickets**: Create and send tickets with QR codes via email
- **Dashboard**: View all issued tickets with statistics
- **Ticket Information**: Name, teacher name, email, status (used/available)
- **QR Code Generation**: Automatic QR code generation for each ticket
- **Email Delivery**: Tickets are automatically sent to the provided email address

### Verification Endpoint (Public)
- **QR Code Scanning**: Scan QR codes to verify tickets
- **Access Grant**: Shows success screen with attendee name
- **Usage Tracking**: Marks tickets as used after verification
- **Error Handling**: Displays appropriate messages for invalid or already-used tickets

## Technology Stack

- **Backend**: Node.js + Express.js
- **Frontend**: Vue 3 + Vue Router + Pinia
- **Database**: PostgreSQL
- **Authentication**: JWT
- **QR Codes**: qrcode library
- **Email**: Nodemailer
- **Deployment**: Docker + Docker Compose

## Prerequisites

- Docker and Docker Compose installed
- Gmail account with App Password (or other SMTP credentials)

## Quick Start

### 1. Clone and Setup

```bash
# Navigate to your project directory
cd convention-ticket-manager

# Configure email settings
# Edit .env file and add your email credentials
nano .env
```

### 2. Configure Email (Important!)

Edit the `.env` file and add your SMTP credentials:

```env
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password-here
```

**For Gmail:**
1. Go to Google Account settings
2. Enable 2-Factor Authentication
3. Generate an App Password: https://support.google.com/accounts/answer/185833
4. Use the 16-character password in the `.env` file

### 3. Start the Application

**Development Mode (with hot reloading):**
```bash
# Start with Vite HMR and nodemon
docker-compose -f docker-compose.dev.yml up --build

# Or run in detached mode
docker-compose -f docker-compose.dev.yml up -d --build
```

**Production Mode:**
```bash
# Build and start all services
docker-compose up --build

# Or run in detached mode
docker-compose up -d --build
```

The application will be available at:
- **Development**:
  - Frontend: http://localhost:8080 (with HMR)
  - Backend API: http://localhost:3000 (with nodemon)
- **Production**:
  - Frontend: http://localhost
  - Backend API: http://localhost:3000

### 4. First Time Setup

1. Open http://localhost in your browser
2. Click "Register" to create an admin account
3. Log in with your credentials
4. Start creating tickets!

## Usage

### Creating a Ticket

1. Log in to the management interface
2. Click "Add New Ticket"
3. Fill in:
   - Attendee Name
   - Teacher Name
   - Email Address
4. Click "Create & Send Ticket"
5. The ticket will be created and emailed with a QR code

### Verifying a Ticket

1. Scan the QR code from the email
2. The verification page will open automatically
3. If valid and unused:
   - Shows "Access Granted" with checkmark
   - Displays attendee name and teacher name
   -Development Mode with Docker (Recommended)

The dev setup includes:
- **Vite HMR** for instant frontend updates
- **Nodemon** for automatic backend restarts
- **Volume mounting** for live code changes
- **PostgreSQL** database

```bash
# Start development environment
docker-compose -f docker-compose.dev.yml up

# Rebuild after package.json changes
docker-compose -f docker-compose.dev.yml up --build

# Stop development environment
docker-compose -f docker-compose.dev.yml down
```

Changes to `.vue`, `.js`, or `.css` files will hot reload instantly!

### Running Without Docker

**Backend:**
```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your configuration
npm run migrate  # Run database migrations
npm run seed     # Create default admin user
npm run dev      # Start development server with nodemon
```

**Frontend:**
```bash
cd frontend
npm install
npm run dev      # Start Vite dev server with HMR
```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your configuration
npm run migrate  # Run database migrations
npm run dev      # Start development server
```

**Frontend:**
```bash
cd frontend
npm install
npm run serve    # Start development server
```

### Database Schema

**Users Table:**
- id (Serial Primary Key)
- username (Unique)
- password (Hashed)
- created_at (Timestamp)

**Tickets Table:**
- id (Serial Primary Key)
- name (Varchar)
- teacher_name (Varchar)
- email (Varchar)
- uuid (Unique UUID)
- is_used (Boolean)
- used_at (Timestamp)
- created_at (Timestamp)

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user

### Tickets (Protected)
- `GET /api/tickets` - Get all tickets
- `POST /api/tickets` - Create and send ticket
- `DELETE /api/tickets/:id` - Delete ticket

### Verification (Public)
- `GET /api/verify/:uuid` - Verify ticket by UUID

## Environment Variables

### Backend (.env)
```env
PORT=3000
DATABASE_URL=postgresql://postgres:password@db:5432/convention_tickets
JWT_SECRET=your-secret-key-change-this
JWT_EXPIRES_IN=7d
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
EMAIL_FROM=Convention Tickets <your-email@gmail.com>
FRONTEND_URL=http://localhost
```

## Security Considerations

1. **Change JWT Secret**: Update `JWT_SECRET` in production
2. **Database Password**: Change PostgreSQL password in docker-compose.yml
3. **HTTPS**: Use HTTPS in production with proper SSL certificates
4. **Email Security**: Use App Passwords, not your actual password
### Development
```bash
# Start dev services with hot reloading
docker-compose -f docker-compose.dev.yml up

# Stop dev services
docker-compose -f docker-compose.dev.yml down

# View dev logs
docker-compose -f docker-compose.dev.yml logs -f

# Rebuild dev services
docker-compose -f docker-compose.dev.yml up --build

# Remove dev volumes (clean database)
docker-compose -f docker-compose.dev.yml down -v
```

### Production
```bash
# Start production services
docker-compose up

# Stop production services
docker-compose down

# View production logs
docker-compose logs -f

# Rebuild production services
docker-compose up --build

# Remove production DATABASE_URL in backend environment

### Frontend Not Loading
- Check if backend is running: http://localhost:3000/health
- Clear browser cache
- Check frontend logs: `docker-compose logs frontend`

## Docker Commands

```bash
# Start services
docker-compose up

# Stop services
docker-compose down

# View logs
docker-compose logs -f

# Rebuild services
docker-compose up --build

# Remove volumes (clean database)
docker-compose down -v
```

## Production Deployment

1. Update environment variables for production
2. Change default passwords and secrets
3. Configure proper domain names
4. Set up SSL/TLS certificates
5. Configure email service (SendGrid, Mailgun, etc.)
6. Set up proper backup for PostgreSQL database
7. Configure firewall rules

## License

MIT

## Support

For issues and questions, please open an issue on the repository.
