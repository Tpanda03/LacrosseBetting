# 🏒 LAX ODDS - Illinois Tech Lacrosse Betting Lines Generator

A full-stack web application that scrapes lacrosse statistics, generates betting odds, and allows users to save their picks across devices.

## Features

- 🤖 **Autonomous Web Scraping** - Automatically discovers opponent websites and scrapes their stats
- 🔄 **Scheduled Updates** - Refreshes data every 6 hours (configurable)
- 📊 **Odds Generation** - Calculates moneyline, spread, and totals using Pythagorean expectation
- 👤 **User Authentication** - Register, login, and save picks across devices
- 📱 **Responsive Design** - Works on desktop and mobile
- 🗄️ **PostgreSQL Database** - Persistent storage for all data

## How the Autonomous Scraper Works

The scraper operates completely autonomously:

1. **Fetches IIT Schedule** - Gets the current schedule from Illinois Tech Athletics
2. **Identifies Opponents** - Extracts all opponent team names from the schedule
3. **Discovers Stats Pages** - For each opponent:
   - Searches the web (DuckDuckGo) for the team's athletics website
   - Tries common domain patterns (e.g., `{team}athletics.com`, `athletics.{team}.edu`)
   - Locates the men's lacrosse statistics page
4. **Scrapes Stats** - Extracts team and player statistics from each discovered page
5. **Generates Odds** - Calculates betting lines based on the scraped data
6. **Stores Everything** - Saves to PostgreSQL for persistence

## Quick Start

### Option 1: Docker (Recommended)

```bash
# Clone or download the project
cd lax-odds-server

# Start with Docker Compose
docker-compose up -d

# View logs
docker-compose logs -f app
```

The app will be available at `http://localhost:3000`

### Option 2: Manual Setup

1. **Install PostgreSQL** and create a database:
```sql
CREATE DATABASE laxodds;
```

2. **Configure environment**:
```bash
cp .env.example .env
# Edit .env with your database credentials
```

3. **Install dependencies and start**:
```bash
npm install
npm run setup-db  # Create tables
npm start
```

## Deployment Options

### 🚀 Railway (Recommended - Free Tier Available)

1. Create account at [railway.app](https://railway.app)
2. Click "New Project" → "Deploy from GitHub"
3. Connect your repository
4. Add PostgreSQL plugin (click + Add → Database → PostgreSQL)
5. Railway auto-detects Node.js and deploys

Environment variables are auto-configured. Add these manually:
- `JWT_SECRET` - A secure random string
- `ADMIN_EMAIL` - Your admin email
- `ADMIN_PASSWORD` - Your admin password

### 🌐 Render

1. Create account at [render.com](https://render.com)
2. New → Web Service → Connect GitHub
3. Add PostgreSQL database (New → PostgreSQL)
4. Set environment variables in dashboard

### ☁️ DigitalOcean App Platform

1. Create account at [digitalocean.com](https://digitalocean.com)
2. Apps → Create App → GitHub
3. Add PostgreSQL managed database
4. Configure environment variables

### 🏠 Self-Hosted (VPS)

```bash
# On your VPS (Ubuntu/Debian)
sudo apt update
sudo apt install -y nodejs npm postgresql

# Clone project
git clone <your-repo-url>
cd lax-odds-server

# Install dependencies
npm install

# Setup PostgreSQL
sudo -u postgres createdb laxodds
sudo -u postgres psql -c "CREATE USER laxodds WITH PASSWORD 'yourpassword';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE laxodds TO laxodds;"

# Configure environment
cp .env.example .env
nano .env  # Edit with your settings

# Setup database tables
npm run setup-db

# Run with PM2 (process manager)
npm install -g pm2
pm2 start src/server.js --name laxodds
pm2 save
pm2 startup
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Create account
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Get current user
- `POST /api/auth/logout` - Logout

### Games & Odds
- `GET /api/games` - All games with odds
- `GET /api/games?upcoming=true` - Upcoming games only
- `GET /api/teams` - All teams
- `GET /api/teams/:id/players` - Players for a team

### User Picks
- `POST /api/picks` - Save a pick (requires auth)
- `GET /api/picks` - Get user's picks (requires auth)
- `DELETE /api/picks/:id` - Delete a pick
- `GET /api/picks/stats` - Get betting stats

### Admin
- `POST /api/admin/scrape` - Trigger manual scrape
- `POST /api/admin/generate-odds` - Regenerate odds
- `GET /api/admin/scrape-logs` - View scrape history

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `DATABASE_URL` | PostgreSQL connection string | - |
| `JWT_SECRET` | Secret for JWT tokens | - |
| `JWT_EXPIRES_IN` | Token expiration | 7d |
| `SCRAPE_CRON` | Scrape schedule (cron format) | `0 */6 * * *` |
| `SCRAPE_ON_START` | Run scrape on server start | false |
| `ADMIN_EMAIL` | Admin account email | admin@laxodds.com |
| `ADMIN_PASSWORD` | Admin account password | changeme123 |

## Data Sources

The scraper **autonomously discovers** opponent websites by:
- Searching the web for each team's athletics site
- Trying common domain patterns
- Crawling to find lacrosse stats pages

It always starts from the IIT schedule and dynamically finds opponents - no hardcoded URLs required.

## Scraping Schedule

By default, the scraper runs every 6 hours. Customize with `SCRAPE_CRON`:
- `0 */6 * * *` - Every 6 hours
- `0 */3 * * *` - Every 3 hours
- `0 8,20 * * *` - At 8 AM and 8 PM
- `0 0 * * *` - Daily at midnight

## Security Notes

1. **Change default passwords** - Update `JWT_SECRET` and `ADMIN_PASSWORD` in production
2. **Use HTTPS** - Deploy behind a reverse proxy (nginx) with SSL
3. **Rate limiting** - Built-in rate limiting (100 requests/15 min per IP)

## Troubleshooting

### Database connection issues
```bash
# Check PostgreSQL is running
sudo systemctl status postgresql

# Test connection
psql -h localhost -U laxodds -d laxodds
```

### Scraper not working
```bash
# Run manual scrape
npm run scrape

# Check logs
docker-compose logs app | grep -i scrape
```

### Port already in use
```bash
# Find process using port 3000
lsof -i :3000
kill -9 <PID>
```

## License

MIT License - Use freely for personal projects.

---

Built with ❤️ for Illinois Tech Lacrosse
