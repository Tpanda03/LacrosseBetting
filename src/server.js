require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const path = require('path');

const pool = require('../config/database');
const routes = require('./routes');
const AutonomousScraper = require('./scraper');
const oddsEngine = require('./odds-engine');
const setupDatabase = require('./setup-db');

const app = express();
const PORT = process.env.PORT || 3000;
const GAME_TIMEZONE = process.env.GAME_TIMEZONE || 'America/Chicago';
const POSTGAME_SCRAPE_DELAY_HOURS = Math.max(0, Number(process.env.POSTGAME_SCRAPE_DELAY_HOURS || 3));
const POSTGAME_SCRAPE_POLL_CRON = process.env.POSTGAME_SCRAPE_POLL_CRON || '*/15 * * * *';
const POSTGAME_LOOKBACK_DAYS = Math.max(1, Number(process.env.POSTGAME_LOOKBACK_DAYS || 2));
let postgameScrapeInProgress = false;

// ==========================================
// MIDDLEWARE
// ==========================================

// Security headers
app.use(helmet({
    contentSecurityPolicy: false, // Disable for inline scripts in frontend
    crossOriginEmbedderPolicy: false
}));

// CORS
app.use(cors({
    origin: process.env.CORS_ORIGIN || true,
    credentials: true
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: { error: 'Too many requests, please try again later' }
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// ==========================================
// API ROUTES
// ==========================================

app.use('/api', routes);

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Serve frontend for all other routes (SPA)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ==========================================
// ERROR HANDLING
// ==========================================

app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// ==========================================
// SCHEDULED TASKS
// ==========================================

const scheduleScraping = () => {
    const cronSchedule = process.env.SCRAPE_CRON || '0 */6 * * *'; // Every 6 hours

    cron.schedule(cronSchedule, async () => {
        console.log('\n⏰ Scheduled scrape starting...');
        try {
            const scraper = new AutonomousScraper();
            await scraper.scrapeAll();
            console.log('✅ Scheduled scrape completed\n');
        } catch (error) {
            console.error('❌ Scheduled scrape failed:', error);
        }
    });

    console.log(`📅 Scraping scheduled: ${cronSchedule}`);
};

const parseTimeString = (timeString) => {
    if (!timeString) {
        return null;
    }

    const normalized = String(timeString).trim().toUpperCase();
    if (!normalized || ['TBA', 'TBD', 'POSTPONED'].includes(normalized)) {
        return null;
    }

    if (normalized === 'NOON') {
        return { hour: 12, minute: 0 };
    }

    if (normalized === 'MIDNIGHT') {
        return { hour: 0, minute: 0 };
    }

    const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/);
    if (!match) {
        return null;
    }

    let hour = parseInt(match[1], 10);
    const minute = parseInt(match[2] || '0', 10);
    const meridiem = match[3];

    if (meridiem === 'AM' && hour === 12) {
        hour = 0;
    } else if (meridiem === 'PM' && hour !== 12) {
        hour += 12;
    }

    return { hour, minute };
};

const parseOffsetMinutes = (offsetText) => {
    const match = String(offsetText || '').match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
    if (!match) {
        return 0;
    }

    const sign = match[1] === '-' ? -1 : 1;
    const hours = parseInt(match[2], 10);
    const minutes = parseInt(match[3] || '0', 10);
    return sign * ((hours * 60) + minutes);
};

const getTimezoneOffsetMinutes = (timestamp, timeZone) => {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        timeZoneName: 'shortOffset',
        hour: '2-digit',
        minute: '2-digit'
    });
    const offsetPart = formatter.formatToParts(new Date(timestamp)).find((part) => part.type === 'timeZoneName');
    return parseOffsetMinutes(offsetPart?.value);
};

const zonedDateTimeToUtcTimestamp = (dateValue, timeString, timeZone) => {
    if (!dateValue || !timeString) {
        return null;
    }

    const timeParts = parseTimeString(timeString);
    if (!timeParts) {
        return null;
    }

    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) {
        return null;
    }

    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const day = date.getUTCDate();
    const initialGuess = Date.UTC(year, month, day, timeParts.hour, timeParts.minute, 0, 0);
    const initialOffset = getTimezoneOffsetMinutes(initialGuess, timeZone);
    let timestamp = initialGuess - (initialOffset * 60 * 1000);
    const correctedOffset = getTimezoneOffsetMinutes(timestamp, timeZone);

    if (correctedOffset !== initialOffset) {
        timestamp = initialGuess - (correctedOffset * 60 * 1000);
    }

    return timestamp;
};

const getDuePostgameScrapes = async () => {
    const gamesResult = await pool.query(`
        WITH ranked_games AS (
            SELECT
                g.*,
                ht.name AS home_team_name,
                at.name AS away_team_name,
                ROW_NUMBER() OVER (
                    PARTITION BY g.home_team_id, g.away_team_id, g.game_date
                    ORDER BY g.updated_at DESC NULLS LAST, g.id DESC
                ) AS row_rank
            FROM games g
            LEFT JOIN teams ht ON g.home_team_id = ht.id
            LEFT JOIN teams at ON g.away_team_id = at.id
            WHERE g.game_date >= CURRENT_DATE - ($1::int)
        )
        SELECT *
        FROM ranked_games
        WHERE row_rank = 1
          AND COALESCE(is_completed, false) = false
          AND game_time IS NOT NULL
          AND BTRIM(game_time) <> ''
        ORDER BY game_date ASC, game_time ASC NULLS LAST
    `, [POSTGAME_LOOKBACK_DAYS]);

    const logsResult = await pool.query(`
        SELECT source_url, status, scraped_at
        FROM scrape_logs
        WHERE source_url LIKE 'postgame:%'
          AND scraped_at >= NOW() - ($1::int * INTERVAL '1 day')
        ORDER BY scraped_at DESC
    `, [POSTGAME_LOOKBACK_DAYS + 1]);

    const latestLogByGame = new Map();
    for (const row of logsResult.rows) {
        const gameId = String(row.source_url).split(':')[1];
        if (!gameId || latestLogByGame.has(gameId)) {
            continue;
        }
        latestLogByGame.set(gameId, row);
    }

    const now = Date.now();
    const delayMs = POSTGAME_SCRAPE_DELAY_HOURS * 60 * 60 * 1000;

    return gamesResult.rows.filter((game) => {
        const scheduledTimestamp = zonedDateTimeToUtcTimestamp(game.game_date, game.game_time, GAME_TIMEZONE);
        if (!scheduledTimestamp) {
            return false;
        }

        const triggerTimestamp = scheduledTimestamp + delayMs;
        if (now < triggerTimestamp) {
            return false;
        }

        const latestLog = latestLogByGame.get(String(game.id));
        if (!latestLog) {
            return true;
        }

        return new Date(latestLog.scraped_at).getTime() < triggerTimestamp;
    }).map((game) => ({
        ...game,
        triggerTimestamp: zonedDateTimeToUtcTimestamp(game.game_date, game.game_time, GAME_TIMEZONE)
            + delayMs
    }));
};

const logPostgameScrape = async (gameId, status, errorMessage = null) => {
    try {
        await pool.query(`
            INSERT INTO scrape_logs (source_url, status, records_updated, error_message, duration_ms)
            VALUES ($1, $2, 0, $3, 0)
        `, [`postgame:${gameId}`, status, errorMessage]);
    } catch (error) {
        console.error('❌ Failed to log postgame scrape:', error.message);
    }
};

const runPostgameScrapeCheck = async () => {
    if (postgameScrapeInProgress) {
        return;
    }

    postgameScrapeInProgress = true;

    try {
        const dueGames = await getDuePostgameScrapes();
        if (dueGames.length === 0) {
            return;
        }

        console.log(`\n🕒 Postgame scrape due for ${dueGames.length} game(s)`);
        dueGames.forEach((game) => {
            console.log(`   • ${game.away_team_name || 'Away'} at ${game.home_team_name || 'Home'} (${game.game_time}, ${GAME_TIMEZONE})`);
        });

        const scraper = new AutonomousScraper();
        await scraper.scrapeAll();

        for (const game of dueGames) {
            await logPostgameScrape(game.id, 'success');
        }

        console.log('✅ Postgame scrape completed\n');
    } catch (error) {
        console.error('❌ Postgame scrape failed:', error);

        try {
            const dueGames = await getDuePostgameScrapes();
            for (const game of dueGames) {
                await logPostgameScrape(game.id, 'error', error.message);
            }
        } catch (logError) {
            console.error('❌ Failed to record postgame scrape errors:', logError.message);
        }
    } finally {
        postgameScrapeInProgress = false;
    }
};

const schedulePostgameScraping = () => {
    cron.schedule(POSTGAME_SCRAPE_POLL_CRON, async () => {
        await runPostgameScrapeCheck();
    });

    console.log(
        `🕒 Postgame scrape watcher: ${POSTGAME_SCRAPE_DELAY_HOURS}h after scheduled start (${POSTGAME_SCRAPE_POLL_CRON}, ${GAME_TIMEZONE})`
    );
};

// ==========================================
// STARTUP
// ==========================================

const startServer = async () => {
    try {
        // Test database connection
        await pool.query('SELECT NOW()');
        console.log('✅ Database connected');

        // Setup tables if needed
        await setupDatabase();

        // Start server
        app.listen(PORT, () => {
            console.log(`\n🚀 Server running on http://localhost:${PORT}`);
            console.log(`📡 API available at http://localhost:${PORT}/api`);
            console.log(`🏠 Frontend at http://localhost:${PORT}\n`);
        });

        // Start scheduled scraping
        scheduleScraping();
        schedulePostgameScraping();

        // Initial scrape on startup (optional)
        if (process.env.SCRAPE_ON_START === 'true') {
            console.log('🔄 Running initial scrape...');
            const scraper = new AutonomousScraper();
            await scraper.scrapeAll();
        }

        await runPostgameScrapeCheck();

    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
};

startServer();

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('\n👋 Shutting down gracefully...');
    await pool.end();
    process.exit(0);
});
