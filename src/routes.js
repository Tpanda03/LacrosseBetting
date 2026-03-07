const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticateToken, requireAdmin, optionalAuth, generateToken } = require('./middleware/auth');
const AutonomousScraper = require('./scraper');
const oddsEngine = require('./odds-engine');

const router = express.Router();

function calculatePotentialPayout(oddsAtPick, stake = 0) {
    const normalizedStake = Number(stake) || 0;
    const normalizedOdds = Number(oddsAtPick);

    if (!Number.isFinite(normalizedOdds)) {
        return normalizedStake;
    }

    if (normalizedOdds > 0) {
        return normalizedStake * (normalizedOdds / 100) + normalizedStake;
    }

    return normalizedStake * (100 / Math.abs(normalizedOdds)) + normalizedStake;
}

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
            SELECT *
            FROM teams
            ORDER BY
                CASE WHEN LOWER(name) = 'illinois tech' THEN 0 ELSE 1 END,
                goals_per_game DESC NULLS LAST,
                name
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
        let orderDirection = 'ASC';

        if (upcoming === 'true') {
            whereClause = 'WHERE g.is_completed = false AND g.game_date >= CURRENT_DATE';
        } else if (completed === 'true') {
            whereClause = 'WHERE g.is_completed = true';
            orderDirection = 'DESC';
        }

        const result = await pool.query(`
            WITH ranked_games AS (
                SELECT
                    g.*,
                    ROW_NUMBER() OVER (
                        PARTITION BY g.home_team_id, g.away_team_id, g.game_date
                        ORDER BY g.updated_at DESC NULLS LAST, g.id DESC
                    ) AS row_rank
                FROM games g
                ${whereClause}
            ),
            latest_odds AS (
                SELECT DISTINCT ON (game_id)
                    *
                FROM odds
                ORDER BY game_id, generated_at DESC NULLS LAST, id DESC
            )
            SELECT rg.*,
                   ht.name as home_team_name, ht.abbrev as home_abbrev, ht.record as home_record,
                   at.name as away_team_name, at.abbrev as away_abbrev, at.record as away_record,
                   o.home_moneyline, o.away_moneyline, o.spread_line, o.total_line,
                   o.home_win_prob, o.away_win_prob, o.generated_at as odds_generated_at
            FROM ranked_games rg
            LEFT JOIN teams ht ON rg.home_team_id = ht.id
            LEFT JOIN teams at ON rg.away_team_id = at.id
            LEFT JOIN latest_odds o ON rg.id = o.game_id
            WHERE rg.row_rank = 1
            ORDER BY rg.game_date ${orderDirection}, rg.game_time ASC NULLS LAST
        `);

        const normalizedGames = result.rows.map(game => ({
            ...game,
            spread_line: oddsEngine.normalizeSpreadFromMoneyline({
                homeMoneyline: game.home_moneyline,
                awayMoneyline: game.away_moneyline,
                totalLine: game.total_line,
                homeWinProb: game.home_win_prob,
                rawSpread: game.spread_line
            })
        }));

        res.json(normalizedGames);
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
            WITH latest_props AS (
                SELECT DISTINCT ON (game_id, player_id, prop_type)
                    *
                FROM player_props
                WHERE game_id = $1
                ORDER BY game_id, player_id, prop_type, generated_at DESC NULLS LAST, id DESC
            )
            SELECT
                lp.*,
                p.name as player_name,
                p.number as player_number,
                p.position,
                t.name as team_name,
                g.game_date,
                g.game_time,
                ht.name as home_team_name,
                at.name as away_team_name
            FROM latest_props lp
            JOIN players p ON lp.player_id = p.id
            JOIN teams t ON p.team_id = t.id
            JOIN games g ON lp.game_id = g.id
            LEFT JOIN teams ht ON g.home_team_id = ht.id
            LEFT JOIN teams at ON g.away_team_id = at.id
            ORDER BY t.name ASC, p.points DESC NULLS LAST, p.name ASC, lp.prop_type ASC
        `, [req.params.id]);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch props' });
    }
});

/**
 * GET /api/props
 * Get player props across games
 */
router.get('/props', async (req, res) => {
    try {
        const { upcoming } = req.query;
        const filters = [];

        if (upcoming === 'true') {
            filters.push('rg.is_completed = false');
            filters.push('rg.game_date >= CURRENT_DATE');
        }

        const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

        const result = await pool.query(`
            WITH latest_props AS (
                SELECT DISTINCT ON (game_id, player_id, prop_type)
                    *
                FROM player_props
                ORDER BY game_id, player_id, prop_type, generated_at DESC NULLS LAST, id DESC
            ),
            ranked_games AS (
                SELECT
                    g.*,
                    ROW_NUMBER() OVER (
                        PARTITION BY g.home_team_id, g.away_team_id, g.game_date
                        ORDER BY g.updated_at DESC NULLS LAST, g.id DESC
                    ) AS row_rank
                FROM games g
            )
            SELECT
                lp.*,
                p.name AS player_name,
                p.number AS player_number,
                p.position,
                t.name AS team_name,
                rg.game_date,
                rg.game_time,
                ht.name AS home_team_name,
                at.name AS away_team_name
            FROM latest_props lp
            JOIN players p ON lp.player_id = p.id
            JOIN teams t ON p.team_id = t.id
            JOIN ranked_games rg ON lp.game_id = rg.id AND rg.row_rank = 1
            LEFT JOIN teams ht ON rg.home_team_id = ht.id
            LEFT JOIN teams at ON rg.away_team_id = at.id
            ${whereClause}
            ORDER BY rg.game_date ASC, team_name ASC, player_name ASC, lp.prop_type ASC
        `);

        res.json(result.rows);
    } catch (error) {
        console.error('Props fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch player props' });
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
        const existingResult = await pool.query(`
            SELECT *
            FROM user_picks
            WHERE user_id = $1 AND game_id = $2 AND pick_type = $3
            ORDER BY created_at DESC NULLS LAST, id DESC
            LIMIT 1
        `, [userId, gameId, pickType]);

        const existingPick = existingResult.rows[0];
        if (existingPick?.is_settled) {
            return res.status(400).json({ error: 'This market is already settled.' });
        }

        if (existingPick && String(existingPick.pick_value) === String(pickValue)) {
            await pool.query('DELETE FROM user_picks WHERE id = $1', [existingPick.id]);
            return res.json({ message: 'Pick removed', removed: true, pickType, gameId });
        }

        const payout = calculatePotentialPayout(oddsAtPick, stake);

        if (existingPick) {
            const result = await pool.query(`
                UPDATE user_picks
                SET pick_value = $1,
                    odds_at_pick = $2,
                    stake = $3,
                    potential_payout = $4,
                    created_at = NOW()
                WHERE id = $5
                RETURNING *
            `, [pickValue, oddsAtPick, stake || 0, payout, existingPick.id]);

            return res.json({ message: 'Pick saved', removed: false, pick: result.rows[0] });
        }

        const result = await pool.query(`
            INSERT INTO user_picks (user_id, game_id, pick_type, pick_value, odds_at_pick, stake, potential_payout)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
        `, [userId, gameId, pickType, pickValue, oddsAtPick, stake || 0, payout]);

        res.json({ message: 'Pick saved', removed: false, pick: result.rows[0] });
    } catch (error) {
        console.error('Pick save error:', error);
        res.status(500).json({ error: 'Failed to save pick' });
    }
});

/**
 * POST /api/prop-picks
 * Toggle a user player prop pick
 */
router.post('/prop-picks', authenticateToken, [
    body('propId').isInt(),
    body('pickDirection').isIn(['over', 'under']),
    body('oddsAtPick').isInt()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { propId, pickDirection, oddsAtPick, stake } = req.body;
        const userId = req.user.id;
        const existingResult = await pool.query(`
            SELECT *
            FROM user_prop_picks
            WHERE user_id = $1 AND prop_id = $2
            ORDER BY created_at DESC NULLS LAST, id DESC
            LIMIT 1
        `, [userId, propId]);

        const existingPick = existingResult.rows[0];
        if (existingPick?.is_settled) {
            return res.status(400).json({ error: 'This player prop is already settled.' });
        }

        if (existingPick && String(existingPick.pick_direction) === String(pickDirection)) {
            await pool.query('DELETE FROM user_prop_picks WHERE id = $1', [existingPick.id]);
            return res.json({ message: 'Prop pick removed', removed: true, propId });
        }

        const payout = calculatePotentialPayout(oddsAtPick, stake);

        if (existingPick) {
            const result = await pool.query(`
                UPDATE user_prop_picks
                SET pick_direction = $1,
                    odds_at_pick = $2,
                    stake = $3,
                    potential_payout = $4,
                    created_at = NOW()
                WHERE id = $5
                RETURNING *
            `, [pickDirection, oddsAtPick, stake || 0, payout, existingPick.id]);

            return res.json({ message: 'Prop pick saved', removed: false, pick: result.rows[0] });
        }

        const result = await pool.query(`
            INSERT INTO user_prop_picks (user_id, prop_id, pick_direction, odds_at_pick, stake, potential_payout)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `, [userId, propId, pickDirection, oddsAtPick, stake || 0, payout]);

        res.json({ message: 'Prop pick saved', removed: false, pick: result.rows[0] });
    } catch (error) {
        console.error('Prop pick save error:', error);
        res.status(500).json({ error: 'Failed to save prop pick' });
    }
});

/**
 * GET /api/picks
 * Get user's picks
 */
router.get('/picks', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            WITH game_picks AS (
                SELECT
                    up.id,
                    'game'::text AS pick_scope,
                    up.game_id,
                    NULL::integer AS prop_id,
                    up.pick_type,
                    up.pick_value,
                    up.odds_at_pick,
                    up.stake,
                    up.potential_payout,
                    up.result,
                    up.is_settled,
                    up.created_at,
                    g.game_date,
                    g.home_score,
                    g.away_score,
                    g.is_completed,
                    ht.name AS home_team,
                    at.name AS away_team,
                    NULL::text AS player_name,
                    NULL::text AS team_name,
                    NULL::text AS prop_type,
                    NULL::numeric AS line
                FROM user_picks up
                JOIN games g ON up.game_id = g.id
                LEFT JOIN teams ht ON g.home_team_id = ht.id
                LEFT JOIN teams at ON g.away_team_id = at.id
                WHERE up.user_id = $1
            ),
            prop_picks AS (
                SELECT
                    upp.id,
                    'prop'::text AS pick_scope,
                    pp.game_id,
                    pp.id AS prop_id,
                    'player_prop'::text AS pick_type,
                    upp.pick_direction AS pick_value,
                    upp.odds_at_pick,
                    upp.stake,
                    upp.potential_payout,
                    upp.result,
                    upp.is_settled,
                    upp.created_at,
                    g.game_date,
                    g.home_score,
                    g.away_score,
                    g.is_completed,
                    ht.name AS home_team,
                    at.name AS away_team,
                    p.name AS player_name,
                    t.name AS team_name,
                    pp.prop_type,
                    pp.line
                FROM user_prop_picks upp
                JOIN player_props pp ON upp.prop_id = pp.id
                JOIN players p ON pp.player_id = p.id
                JOIN teams t ON p.team_id = t.id
                JOIN games g ON pp.game_id = g.id
                LEFT JOIN teams ht ON g.home_team_id = ht.id
                LEFT JOIN teams at ON g.away_team_id = at.id
                WHERE upp.user_id = $1
            )
            SELECT *
            FROM (
                SELECT * FROM game_picks
                UNION ALL
                SELECT * FROM prop_picks
            ) combined_picks
            ORDER BY created_at DESC, game_date DESC NULLS LAST
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
            WITH all_picks AS (
                SELECT stake, potential_payout, result, is_settled
                FROM user_picks
                WHERE user_id = $1
                UNION ALL
                SELECT stake, potential_payout, result, is_settled
                FROM user_prop_picks
                WHERE user_id = $1
            )
            SELECT
                COUNT(*) as total_picks,
                COUNT(*) FILTER (WHERE result = 'win') as wins,
                COUNT(*) FILTER (WHERE result = 'loss') as losses,
                COUNT(*) FILTER (WHERE is_settled = false) as pending,
                COALESCE(SUM(stake), 0) as total_staked,
                COALESCE(SUM(CASE WHEN result = 'win' THEN potential_payout ELSE 0 END), 0) as total_won,
                COALESCE(SUM(CASE WHEN result = 'loss' THEN stake ELSE 0 END), 0) as total_lost
            FROM all_picks
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
        const propCount = await oddsEngine.generateAllPlayerProps();
        res.json({ message: `Generated odds for ${count} games and ${propCount} player props` });
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
            WITH latest_games AS (
                SELECT DISTINCT ON (home_team_id, away_team_id, game_date)
                    *
                FROM games
                ORDER BY home_team_id, away_team_id, game_date, updated_at DESC NULLS LAST, id DESC
            )
            SELECT 
                (SELECT COUNT(*) FROM teams) as teams,
                (SELECT COUNT(*) FROM players) as players,
                (SELECT COUNT(*) FROM latest_games) as games,
                (SELECT COUNT(*) FROM latest_games WHERE is_completed = false AND game_date >= CURRENT_DATE) as upcoming_games,
                (SELECT COUNT(*) FROM latest_games WHERE is_completed = true) as completed_games,
                (SELECT COUNT(*) FROM odds) as odds_generated,
                (SELECT COUNT(*) FROM player_props) as props_generated,
                (SELECT COUNT(*) FROM users) as users,
                ((SELECT COUNT(*) FROM user_picks) + (SELECT COUNT(*) FROM user_prop_picks)) as total_picks,
                (SELECT MAX(scraped_at) FROM scrape_logs WHERE status = 'success') as last_scrape,
                (SELECT MAX(generated_at) FROM odds) as last_odds_update
        `);
        res.json(stats.rows[0]);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

module.exports = router;
