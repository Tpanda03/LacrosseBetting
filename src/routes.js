const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticateToken, requireAdmin, optionalAuth, generateToken } = require('./middleware/auth');
const AutonomousScraper = require('./scraper');
const oddsEngine = require('./odds-engine');

const router = express.Router();

// ==========================================
// AUTH ROUTES
// ==========================================

/**
 * POST /api/auth/register
 * Register a new user
 */
router.post('/auth/register', [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 6 }),
    body('username').isLength({ min: 2, max: 50 }).trim()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { email, password, username } = req.body;

        // Check if user exists
        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        // Hash password
        const passwordHash = await bcrypt.hash(password, 12);

        // Create user
        const result = await pool.query(`
            INSERT INTO users (email, password_hash, username)
            VALUES ($1, $2, $3)
            RETURNING id, email, username, role, created_at
        `, [email, passwordHash, username]);

        const user = result.rows[0];
        const token = generateToken(user.id, user.email);

        res.status(201).json({
            message: 'Registration successful',
            user: { id: user.id, email: user.email, username: user.username },
            token
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

/**
 * POST /api/auth/login
 * Login user
 */
router.post('/auth/login', [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty()
], async (req, res) => {
    try {
        const { email, password } = req.body;

        // Find user
        const result = await pool.query(
            'SELECT id, email, username, password_hash, role, is_active FROM users WHERE email = $1',
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const user = result.rows[0];

        if (!user.is_active) {
            return res.status(401).json({ error: 'Account is inactive' });
        }

        // Verify password
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Update last login
        await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

        const token = generateToken(user.id, user.email);

        res.json({
            message: 'Login successful',
            user: { id: user.id, email: user.email, username: user.username, role: user.role },
            token
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

/**
 * GET /api/auth/me
 * Get current user info
 */
router.get('/auth/me', authenticateToken, async (req, res) => {
    res.json({ user: req.user });
});

/**
 * POST /api/auth/logout
 * Logout (client should discard token)
 */
router.post('/auth/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ message: 'Logged out' });
});

// ==========================================
// TEAMS & PLAYERS
// ==========================================

/**
 * GET /api/teams
 * Get all teams
 */
router.get('/teams', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT * FROM teams ORDER BY name
        `);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch teams' });
    }
});

/**
 * GET /api/teams/:id/players
 * Get players for a team
 */
router.get('/teams/:id/players', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT * FROM players WHERE team_id = $1 ORDER BY points DESC, goals DESC
        `, [req.params.id]);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch players' });
    }
});

// ==========================================
// GAMES & ODDS
// ==========================================

/**
 * GET /api/games
 * Get all games with odds
 */
router.get('/games', async (req, res) => {
    try {
        const { upcoming, completed } = req.query;
        let whereClause = '';

        if (upcoming === 'true') {
            whereClause = 'WHERE g.is_completed = false AND g.game_date >= CURRENT_DATE';
        } else if (completed === 'true') {
            whereClause = 'WHERE g.is_completed = true';
        }

        const result = await pool.query(`
            SELECT g.*,
                   ht.name as home_team_name, ht.abbrev as home_abbrev, ht.record as home_record,
                   at.name as away_team_name, at.abbrev as away_abbrev, at.record as away_record,
                   o.home_moneyline, o.away_moneyline, o.spread_line, o.total_line,
                   o.home_win_prob, o.away_win_prob, o.generated_at as odds_generated_at
            FROM games g
            LEFT JOIN teams ht ON g.home_team_id = ht.id
            LEFT JOIN teams at ON g.away_team_id = at.id
            LEFT JOIN odds o ON g.id = o.game_id
            ${whereClause}
            ORDER BY g.game_date ASC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Games fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch games' });
    }
});

/**
 * GET /api/games/:id/props
 * Get player props for a game
 */
router.get('/games/:id/props', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT pp.*, p.name as player_name, p.number as player_number, p.position
            FROM player_props pp
            JOIN players p ON pp.player_id = p.id
            WHERE pp.game_id = $1
            ORDER BY p.points DESC
        `, [req.params.id]);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch props' });
    }
});

// ==========================================
// USER PICKS
// ==========================================

/**
 * POST /api/picks
 * Save a user pick
 */
router.post('/picks', authenticateToken, [
    body('gameId').isInt(),
    body('pickType').isIn(['moneyline', 'spread', 'total']),
    body('pickValue').notEmpty(),
    body('oddsAtPick').isInt()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { gameId, pickType, pickValue, oddsAtPick, stake } = req.body;
        const userId = req.user.id;

        // Calculate potential payout
        let payout = stake || 0;
        if (oddsAtPick > 0) {
            payout = stake * (oddsAtPick / 100) + stake;
        } else {
            payout = stake * (100 / Math.abs(oddsAtPick)) + stake;
        }

        const result = await pool.query(`
            INSERT INTO user_picks (user_id, game_id, pick_type, pick_value, odds_at_pick, stake, potential_payout)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (user_id, game_id, pick_type) DO UPDATE SET
                pick_value = EXCLUDED.pick_value,
                odds_at_pick = EXCLUDED.odds_at_pick,
                stake = EXCLUDED.stake,
                potential_payout = EXCLUDED.potential_payout,
                created_at = NOW()
            RETURNING *
        `, [userId, gameId, pickType, pickValue, oddsAtPick, stake || 0, payout]);

        res.json({ message: 'Pick saved', pick: result.rows[0] });
    } catch (error) {
        console.error('Pick save error:', error);
        res.status(500).json({ error: 'Failed to save pick' });
    }
});

/**
 * GET /api/picks
 * Get user's picks
 */
router.get('/picks', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT up.*,
                   g.game_date, g.home_score, g.away_score, g.is_completed,
                   ht.name as home_team, at.name as away_team
            FROM user_picks up
            JOIN games g ON up.game_id = g.id
            LEFT JOIN teams ht ON g.home_team_id = ht.id
            LEFT JOIN teams at ON g.away_team_id = at.id
            WHERE up.user_id = $1
            ORDER BY g.game_date DESC
        `, [req.user.id]);

        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch picks' });
    }
});

/**
 * DELETE /api/picks/:id
 * Delete a pick
 */
router.delete('/picks/:id', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            DELETE FROM user_picks WHERE id = $1 AND user_id = $2 AND is_settled = false
            RETURNING id
        `, [req.params.id, req.user.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Pick not found or already settled' });
        }

        res.json({ message: 'Pick deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete pick' });
    }
});

/**
 * GET /api/picks/stats
 * Get user's betting stats
 */
router.get('/picks/stats', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                COUNT(*) as total_picks,
                COUNT(*) FILTER (WHERE result = 'win') as wins,
                COUNT(*) FILTER (WHERE result = 'loss') as losses,
                COUNT(*) FILTER (WHERE is_settled = false) as pending,
                COALESCE(SUM(stake), 0) as total_staked,
                COALESCE(SUM(CASE WHEN result = 'win' THEN potential_payout ELSE 0 END), 0) as total_won,
                COALESCE(SUM(CASE WHEN result = 'loss' THEN stake ELSE 0 END), 0) as total_lost
            FROM user_picks
            WHERE user_id = $1
        `, [req.user.id]);

        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// ==========================================
// ADMIN ROUTES
// ==========================================

/**
 * POST /api/admin/scrape
 * Trigger manual scrape
 */
router.post('/admin/scrape', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const scraper = new AutonomousScraper();
        const results = await scraper.scrapeAll();

        res.json({ message: 'Autonomous scrape completed', results });
    } catch (error) {
        console.error('Scrape error:', error);
        res.status(500).json({ error: 'Scrape failed' });
    }
});

/**
 * POST /api/admin/generate-odds
 * Regenerate all odds
 */
router.post('/admin/generate-odds', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const count = await oddsEngine.generateAllOdds();
        res.json({ message: `Generated odds for ${count} games` });
    } catch (error) {
        res.status(500).json({ error: 'Odds generation failed' });
    }
});

/**
 * GET /api/admin/scrape-logs
 * Get scrape history
 */
router.get('/admin/scrape-logs', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT * FROM scrape_logs ORDER BY scraped_at DESC LIMIT 50
        `);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch logs' });
    }
});

/**
 * GET /api/admin/users
 * Get all users
 */
router.get('/admin/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, email, username, role, is_active, created_at, last_login
            FROM users ORDER BY created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// ==========================================
// STATS ENDPOINT
// ==========================================

/**
 * GET /api/stats
 * Get overall system stats
 */
router.get('/stats', async (req, res) => {
    try {
        const stats = await pool.query(`
            SELECT 
                (SELECT COUNT(*) FROM teams) as teams,
                (SELECT COUNT(*) FROM players) as players,
                (SELECT COUNT(*) FROM games) as games,
                (SELECT COUNT(*) FROM games WHERE is_completed = false AND game_date >= CURRENT_DATE) as upcoming_games,
                (SELECT COUNT(*) FROM odds) as odds_generated,
                (SELECT COUNT(*) FROM users) as users,
                (SELECT COUNT(*) FROM user_picks) as total_picks,
                (SELECT MAX(scraped_at) FROM scrape_logs WHERE status = 'success') as last_scrape
        `);
        res.json(stats.rows[0]);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

module.exports = router;
