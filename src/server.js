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

        // Initial scrape on startup (optional)
        if (process.env.SCRAPE_ON_START === 'true') {
            console.log('🔄 Running initial scrape...');
            const scraper = new AutonomousScraper();
            await scraper.scrapeAll();
        }

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
