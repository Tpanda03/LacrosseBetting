const pool = require('../config/database');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const setupDatabase = async () => {
    const client = await pool.connect();
    
    try {
        console.log('🚀 Setting up database tables...\n');

        // Users table
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                username VARCHAR(100) NOT NULL,
                role VARCHAR(20) DEFAULT 'user',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP,
                is_active BOOLEAN DEFAULT true
            );
        `);
        console.log('✅ Users table created');

        // Teams table
        await client.query(`
            CREATE TABLE IF NOT EXISTS teams (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                abbrev VARCHAR(10),
                record VARCHAR(20),
                wins INTEGER DEFAULT 0,
                losses INTEGER DEFAULT 0,
                games INTEGER DEFAULT 0,
                goals INTEGER DEFAULT 0,
                goals_allowed INTEGER DEFAULT 0,
                assists INTEGER DEFAULT 0,
                shots INTEGER DEFAULT 0,
                shots_allowed INTEGER DEFAULT 0,
                shot_pct DECIMAL(5,3),
                ground_balls INTEGER DEFAULT 0,
                turnovers INTEGER DEFAULT 0,
                caused_turnovers INTEGER DEFAULT 0,
                faceoff_pct DECIMAL(5,3),
                clear_pct DECIMAL(5,3),
                save_pct DECIMAL(5,3),
                goals_per_game DECIMAL(5,2),
                goals_allowed_per_game DECIMAL(5,2),
                source_url VARCHAR(500),
                last_scraped TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Teams table created');

        // Players table
        await client.query(`
            CREATE TABLE IF NOT EXISTS players (
                id SERIAL PRIMARY KEY,
                team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
                number VARCHAR(10),
                name VARCHAR(100) NOT NULL,
                position VARCHAR(10),
                games_played INTEGER DEFAULT 0,
                goals INTEGER DEFAULT 0,
                assists INTEGER DEFAULT 0,
                points INTEGER DEFAULT 0,
                shots INTEGER DEFAULT 0,
                shot_pct DECIMAL(5,3),
                ground_balls INTEGER DEFAULT 0,
                turnovers INTEGER DEFAULT 0,
                caused_turnovers INTEGER DEFAULT 0,
                saves INTEGER DEFAULT 0,
                save_pct DECIMAL(5,3),
                gaa DECIMAL(5,2),
                faceoff_pct DECIMAL(5,3),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Players table created');

        // Games/Schedule table
        await client.query(`
            CREATE TABLE IF NOT EXISTS games (
                id SERIAL PRIMARY KEY,
                home_team_id INTEGER REFERENCES teams(id),
                away_team_id INTEGER REFERENCES teams(id),
                game_date DATE NOT NULL,
                game_time VARCHAR(20),
                location VARCHAR(200),
                is_home_game BOOLEAN,
                is_conference BOOLEAN DEFAULT false,
                home_score INTEGER,
                away_score INTEGER,
                is_completed BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Games table created');

        // Generated Odds table
        await client.query(`
            CREATE TABLE IF NOT EXISTS odds (
                id SERIAL PRIMARY KEY,
                game_id INTEGER REFERENCES games(id) ON DELETE CASCADE,
                home_moneyline INTEGER,
                away_moneyline INTEGER,
                spread_line DECIMAL(4,1),
                spread_odds INTEGER DEFAULT -110,
                total_line DECIMAL(4,1),
                over_odds INTEGER DEFAULT -110,
                under_odds INTEGER DEFAULT -110,
                home_win_prob DECIMAL(5,2),
                away_win_prob DECIMAL(5,2),
                generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Odds table created');

        // User Picks table
        await client.query(`
            CREATE TABLE IF NOT EXISTS user_picks (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                game_id INTEGER REFERENCES games(id) ON DELETE CASCADE,
                pick_type VARCHAR(20) NOT NULL,
                pick_value VARCHAR(50) NOT NULL,
                odds_at_pick INTEGER,
                stake DECIMAL(10,2),
                potential_payout DECIMAL(10,2),
                result VARCHAR(20),
                is_settled BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                settled_at TIMESTAMP,
                CONSTRAINT unique_user_game_pick UNIQUE(user_id, game_id, pick_type)
            );
        `);
        console.log('✅ User Picks table created');

        // Player Props table
        await client.query(`
            CREATE TABLE IF NOT EXISTS player_props (
                id SERIAL PRIMARY KEY,
                game_id INTEGER REFERENCES games(id) ON DELETE CASCADE,
                player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
                prop_type VARCHAR(50) NOT NULL,
                line DECIMAL(4,1),
                over_odds INTEGER,
                under_odds INTEGER,
                generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Player Props table created');

        // User Player Prop Picks table
        await client.query(`
            CREATE TABLE IF NOT EXISTS user_prop_picks (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                prop_id INTEGER REFERENCES player_props(id) ON DELETE CASCADE,
                pick_direction VARCHAR(10) NOT NULL,
                odds_at_pick INTEGER,
                stake DECIMAL(10,2),
                potential_payout DECIMAL(10,2),
                result VARCHAR(20),
                is_settled BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                settled_at TIMESTAMP
            );
        `);
        console.log('✅ User Prop Picks table created');

        // Scrape logs table
        await client.query(`
            CREATE TABLE IF NOT EXISTS scrape_logs (
                id SERIAL PRIMARY KEY,
                source_url VARCHAR(500),
                status VARCHAR(20),
                records_updated INTEGER DEFAULT 0,
                error_message TEXT,
                duration_ms INTEGER,
                scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Scrape Logs table created');

        // Create indexes for better performance
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_picks_user ON user_picks(user_id);
            CREATE INDEX IF NOT EXISTS idx_picks_game ON user_picks(game_id);
            CREATE INDEX IF NOT EXISTS idx_games_date ON games(game_date);
            CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id);
            CREATE INDEX IF NOT EXISTS idx_odds_game ON odds(game_id);
        `);
        console.log('✅ Indexes created');

        // Create admin user if doesn't exist
        const adminEmail = process.env.ADMIN_EMAIL || 'admin@laxodds.com';
        const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
        const hashedPassword = await bcrypt.hash(adminPassword, 12);

        await client.query(`
            INSERT INTO users (email, password_hash, username, role)
            VALUES ($1, $2, 'Admin', 'admin')
            ON CONFLICT (email) DO NOTHING
        `, [adminEmail, hashedPassword]);
        console.log('✅ Admin user created/verified');

        console.log('\n🎉 Database setup complete!');
        console.log(`📧 Admin email: ${adminEmail}`);
        console.log(`🔑 Admin password: ${adminPassword} (change this!)\n`);

    } catch (error) {
        console.error('❌ Database setup error:', error);
        throw error;
    } finally {
        client.release();
    }
};

// Run if called directly
if (require.main === module) {
    setupDatabase()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
}

module.exports = setupDatabase;
