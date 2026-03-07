# 🏒 LAX ODDS - Illinois Tech Lacrosse Betting Lines Generator

A full-stack web application that scrapes lacrosse statistics, generates betting odds, and allows users to save their picks across devices.

## Features

- 🤖 **Autonomous Web Scraping** - Automatically discovers opponent websites and scrapes their stats
- 🔄 **Scheduled Updates** - Refreshes data every 6 hours (configurable)
- 📊 **Odds Generation** - Calculates moneyline, spread, and totals using Pythagorean expectation
- 🎯 **Player Props** - Generates goals, points, shots, saves, and faceoff percentage props for upcoming games
- 👤 **User Authentication** - Register, login, and save picks across devices
- 📱 **Responsive Design** - Works on desktop and mobile
- 🗄️ **PostgreSQL Database** - Persistent storage for all data
- 🔌 **API-Aware Frontend** - The standalone `public/index.html` auto-connects to a live backend when one is available

## How the Autonomous Scraper Works

The scraper operates completely autonomously:

1. **Fetches IIT Schedule** - Gets the current schedule from Illinois Tech Athletics
2. **Identifies Opponents** - Extracts all opponent team names from the schedule
3. **Discovers Stats Pages** - For each opponent:
   - Uses the opponent links published on the IIT schedule page when available
   - Applies manual overrides from `src/team-url-overrides.json`
   - Falls back to search + common domain patterns if needed
   - Locates the men's lacrosse statistics page
4. **Scrapes Stats** - Extracts team and player statistics from each discovered page
5. **Generates Odds** - Calculates betting lines based on the scraped data
6. **Stores Everything** - Saves to PostgreSQL for persistence

## Quick Start with Railway (Recommended)

Railway is the easiest way to deploy this app. Free tier available!

### Step 1: Create Railway Account
1. Go to [railway.app](https://railway.app)
2. Sign up with GitHub

### Step 2: Deploy from GitHub
1. Push this code to a GitHub repository
2. In Railway: **New Project** → **Deploy from GitHub repo**
3. Select your repository

### Step 3: Add PostgreSQL Database
1. In your Railway project, click **+ New**
2. Select **Database** → **Add PostgreSQL**
3. Railway automatically creates `DATABASE_URL` env var

### Step 4: Configure Environment Variables
In Railway dashboard → your service → **Variables** tab, add:

| Variable | Value | Required |
|----------|-------|----------|
| `JWT_SECRET` | `your-random-secret-key-here` | ✅ Yes |
| `ADMIN_EMAIL` | `your@email.com` | ✅ Yes |
| `ADMIN_PASSWORD` | `your-secure-password` | ✅ Yes |
| `SCRAPE_ON_START` | `true` | Optional |
| `SCRAPE_CRON` | `0 */6 * * *` | Optional (every 6 hrs) |

### Step 5: Deploy!
Railway auto-deploys when you push to GitHub. Your app will be live at:
`https://your-project-name.up.railway.app`

---

## API Endpoints

### Authentication
- `POST /api/auth/register` - Create account
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Get current user
- `POST /api/auth/logout` - Logout

### Games & Odds
- `GET /api/games` - All games with odds
- `GET /api/games?upcoming=true` - Upcoming games only
- `GET /api/props?upcoming=true` - Player props for upcoming games
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
- Using opponent links from the IIT schedule whenever they exist
- Consulting `src/team-url-overrides.json` for hard overrides
- Searching the web for each team's athletics site
- Trying common domain patterns and crawling to find lacrosse stats pages

It always starts from the IIT schedule and dynamically finds opponents - no hardcoded URLs required.

If a specific team keeps missing, add a manual entry to `src/team-url-overrides.json`.

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
