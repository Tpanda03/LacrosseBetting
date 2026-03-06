const axios = require('axios');
const cheerio = require('cheerio');
const pool = require('../config/database');

/**
 * AUTONOMOUS LACROSSE SCRAPER v2.0
 * 
 * Fully autonomous operation:
 * 1. Fetches IIT schedule to discover opponents
 * 2. Searches the web to find each opponent's athletics site
 * 3. Locates and scrapes their lacrosse stats page
 * 4. Stores everything in the database
 */

class AutonomousScraper {
    constructor() {
        this.client = axios.create({
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });

        this.IIT_SCHEDULE_URL = 'https://illinoistechathletics.com/sports/mlax/schedule';
        this.IIT_STATS_URL = 'https://illinoistechathletics.com/sports/mens-lacrosse/stats';
        
        // URL cache for this session
        this.urlCache = new Map();
        
        // Stats page path patterns to try
        this.statsPatterns = [
            '/sports/mens-lacrosse/stats',
            '/sports/mlax/stats',
            '/sports/mens-lacrosse/stats/',
            '/sports/m-lacros/stats'
        ];
    }

    // ═══════════════════════════════════════════════════════════════════
    // MAIN ENTRY POINT
    // ═══════════════════════════════════════════════════════════════════

    async scrapeAll() {
        console.log('\n' + '═'.repeat(65));
        console.log('🤖 AUTONOMOUS LACROSSE SCRAPER');
        console.log('═'.repeat(65));
        console.log(`Started: ${new Date().toLocaleString()}\n`);

        const results = { iit: null, opponents: [], games: [], errors: [] };
        const startTime = Date.now();

        try {
            // Step 1: Scrape IIT
            console.log('┌─ STEP 1: Scraping Illinois Tech');
            results.iit = await this.scrapeTeamFromUrl('Illinois Tech', this.IIT_STATS_URL);
            console.log(`│  ✓ Record: ${results.iit?.team?.record || 'unknown'}\n│`);

            // Step 2: Get schedule
            console.log('├─ STEP 2: Fetching Schedule');
            const schedule = await this.getSchedule();
            results.games = schedule;
            console.log(`│  ✓ Found ${schedule.length} games\n│`);

            // Step 3: Find unique opponents
            const opponents = [...new Set(schedule.map(g => g.opponent).filter(Boolean))];
            console.log('├─ STEP 3: Scraping Opponents');
            console.log(`│  Found ${opponents.length} unique opponents:\n│`);

            // Step 4: Scrape each opponent autonomously
            for (let i = 0; i < opponents.length; i++) {
                const opp = opponents[i];
                console.log(`│  [${i+1}/${opponents.length}] ${opp}`);
                
                try {
                    const result = await this.findAndScrapeTeam(opp);
                    results.opponents.push(result);
                    
                    if (result.success) {
                        console.log(`│      ✓ ${result.team?.record || 'OK'} - ${result.players?.length || 0} players`);
                        console.log(`│      URL: ${result.url}`);
                    } else {
                        console.log(`│      ⚠ Using estimates`);
                    }
                } catch (err) {
                    console.log(`│      ✗ ${err.message}`);
                    results.errors.push({ team: opp, error: err.message });
                }
                
                await this.sleep(1500); // Rate limit
            }

            // Step 5: Store in database
            console.log('│\n├─ STEP 4: Storing Data');
            await this.storeSchedule(schedule);
            console.log('│  ✓ Schedule saved\n│');

            // Summary
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            const successful = results.opponents.filter(o => o.success).length;
            
            console.log('└─ COMPLETE\n');
            console.log('═'.repeat(65));
            console.log(`Duration: ${duration}s | Opponents: ${successful}/${opponents.length} | Games: ${schedule.length}`);
            console.log('═'.repeat(65) + '\n');

            return results;
        } catch (error) {
            console.error('CRITICAL ERROR:', error);
            throw error;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // AUTONOMOUS TEAM DISCOVERY
    // ═══════════════════════════════════════════════════════════════════

    async findAndScrapeTeam(teamName) {
        // Step 1: Check cache
        if (this.urlCache.has(teamName.toLowerCase())) {
            const url = this.urlCache.get(teamName.toLowerCase());
            return await this.scrapeTeamFromUrl(teamName, url);
        }

        // Step 2: Try to discover the athletics website
        const statsUrl = await this.discoverStatsUrl(teamName);
        
        if (statsUrl) {
            this.urlCache.set(teamName.toLowerCase(), statsUrl);
            return await this.scrapeTeamFromUrl(teamName, statsUrl);
        }

        // Step 3: Return estimated stats if discovery fails
        return this.createEstimatedTeam(teamName);
    }

    async discoverStatsUrl(teamName) {
        const searchQueries = this.generateSearchQueries(teamName);
        
        for (const query of searchQueries) {
            try {
                // Try DuckDuckGo HTML search (no API key needed)
                const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
                const response = await this.client.get(ddgUrl, { timeout: 10000 });
                const $ = cheerio.load(response.data);
                
                // Find athletics website links in results
                const links = [];
                $('a.result__a, a.result__url').each((i, el) => {
                    const href = $(el).attr('href') || '';
                    if (this.isAthleticsSite(href)) {
                        links.push(this.extractUrl(href));
                    }
                });

                // Try each discovered domain
                for (const baseUrl of links.slice(0, 3)) {
                    const statsUrl = await this.findStatsPage(baseUrl);
                    if (statsUrl) return statsUrl;
                }
            } catch (err) {
                // Search failed, try next method
            }
        }

        // Try common domain patterns directly
        return await this.tryCommonDomains(teamName);
    }

    generateSearchQueries(teamName) {
        const clean = teamName.replace(/\([^)]+\)/g, '').trim();
        return [
            `${clean} men's lacrosse statistics`,
            `${clean} university athletics lacrosse`,
            `${clean} college lacrosse stats`
        ];
    }

    isAthleticsSite(url) {
        const patterns = ['athletics', 'sports', 'goforesters', 'tigers', 'eagles', 
                         'hawks', 'bluejays', 'knights', 'raiders', 'vikings', 'rams'];
        return patterns.some(p => url.toLowerCase().includes(p));
    }

    extractUrl(href) {
        // DuckDuckGo wraps URLs, extract the actual URL
        const match = href.match(/uddg=([^&]+)/);
        if (match) {
            return decodeURIComponent(match[1]);
        }
        if (href.startsWith('http')) {
            return href;
        }
        return null;
    }

    async findStatsPage(baseUrl) {
        if (!baseUrl) return null;
        
        try {
            const urlObj = new URL(baseUrl);
            const domain = `${urlObj.protocol}//${urlObj.host}`;

            // Try each stats path pattern
            for (const path of this.statsPatterns) {
                const testUrl = `${domain}${path}`;
                try {
                    const resp = await this.client.get(testUrl, { timeout: 8000 });
                    if (resp.status === 200 && this.isValidStatsPage(resp.data)) {
                        return testUrl;
                    }
                } catch (e) {
                    // Path doesn't exist, try next
                }
            }
        } catch (e) {
            // Invalid URL
        }
        return null;
    }

    isValidStatsPage(html) {
        const lower = html.toLowerCase();
        return lower.includes('lacrosse') && 
               (lower.includes('goals') || lower.includes('statistics') || lower.includes('stats')) &&
               lower.includes('<table');
    }

    async tryCommonDomains(teamName) {
        const slug = this.slugify(teamName);
        const domains = [
            `https://${slug}athletics.com`,
            `https://athletics.${slug}.edu`,
            `https://www.${slug}athletics.com`,
            `https://${slug}sports.com`,
            `https://go${slug}.com`,
            `https://www.go${slug}.com`
        ];

        for (const domain of domains) {
            for (const path of this.statsPatterns) {
                try {
                    const url = `${domain}${path}`;
                    const resp = await this.client.get(url, { timeout: 6000 });
                    if (resp.status === 200 && this.isValidStatsPage(resp.data)) {
                        return url;
                    }
                } catch (e) {
                    // Domain/path combo doesn't work
                }
            }
        }
        return null;
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEAM SCRAPING
    // ═══════════════════════════════════════════════════════════════════

    async scrapeTeamFromUrl(teamName, url) {
        const startTime = Date.now();
        
        try {
            const response = await this.client.get(url);
            const $ = cheerio.load(response.data);

            const team = this.parseTeamStats($, teamName);
            const players = this.parsePlayers($);

            // Save to database
            const teamId = await this.upsertTeam(team, url);
            for (const player of players) {
                await this.upsertPlayer(player, teamId);
            }

            await this.logScrape(url, 'success', players.length, null, Date.now() - startTime);

            return { success: true, team, players, url };
        } catch (error) {
            await this.logScrape(url, 'error', 0, error.message, Date.now() - startTime);
            return this.createEstimatedTeam(teamName);
        }
    }

    parseTeamStats($, teamName) {
        const stats = {
            name: teamName,
            abbrev: this.createAbbrev(teamName),
            wins: 0, losses: 0, goals: 0, goalsAllowed: 0,
            shots: 0, faceoffPct: 0.5, clearPct: 0.75, savePct: 0.55
        };

        // Find record
        const pageText = $('body').text();
        const recordMatch = pageText.match(/\((\d+)-(\d+)(?:-\d+)?\)/);
        if (recordMatch) {
            stats.wins = parseInt(recordMatch[1]);
            stats.losses = parseInt(recordMatch[2]);
        }

        // Parse team stats table
        $('table').each((i, table) => {
            $(table).find('tr').each((j, row) => {
                const rowText = $(row).text().toLowerCase();
                const cells = $(row).find('td');
                
                if (cells.length >= 2) {
                    const val = this.parseNum($(cells[0]).text()) || this.parseNum($(cells[1]).text());
                    
                    if (rowText.includes('goals') && !rowText.includes('per') && !rowText.includes('allowed')) {
                        if (val > 0 && val < 500) stats.goals = val;
                    }
                    if (rowText.includes('goals allowed') || rowText.includes('goals against')) {
                        if (val > 0 && val < 500) stats.goalsAllowed = val;
                    }
                    if (rowText.includes('shot') && !rowText.includes('%')) {
                        if (val > 0) stats.shots = val;
                    }
                    if (rowText.includes('faceoff') && rowText.includes('%')) {
                        const pct = this.parsePct($(cells[0]).text()) || this.parsePct($(cells[1]).text());
                        if (pct) stats.faceoffPct = pct;
                    }
                    if (rowText.includes('clear') && rowText.includes('%')) {
                        const pct = this.parsePct($(cells[0]).text()) || this.parsePct($(cells[1]).text());
                        if (pct) stats.clearPct = pct;
                    }
                }
            });
        });

        // Calculate derived stats
        stats.games = Math.max(stats.wins + stats.losses, 1);
        stats.record = `${stats.wins}-${stats.losses}`;
        stats.goalsPerGame = stats.goals / stats.games;
        stats.goalsAllowedPerGame = stats.goalsAllowed / stats.games;
        stats.shotPct = stats.shots > 0 ? stats.goals / stats.shots : 0;

        return stats;
    }

    parsePlayers($) {
        const players = [];

        $('table').each((i, table) => {
            const headers = $(table).find('th').map((j, th) => $(th).text().trim().toLowerCase()).get();
            
            const hasPlayer = headers.some(h => h.includes('player') || h.includes('name'));
            const hasStats = headers.some(h => ['g', 'a', 'pts', 'goals'].includes(h));

            if (hasPlayer || hasStats) {
                $(table).find('tbody tr, tr').each((j, row) => {
                    const cells = $(row).find('td');
                    if (cells.length < 3) return;

                    const player = { number: '', name: '', position: 'M', gamesPlayed: 0, 
                                    goals: 0, assists: 0, points: 0, shots: 0, saves: 0 };

                    cells.each((k, cell) => {
                        const text = $(cell).text().trim();
                        const header = headers[k] || '';

                        if (header === '#' || k === 0) player.number = text.match(/\d+/)?.[0] || '';
                        if (header.includes('name') || header.includes('player') || k === 1) {
                            player.name = text.replace(/view bio/i, '').trim();
                        }
                        if (header === 'gp') player.gamesPlayed = this.parseNum(text);
                        if (header === 'g' && header !== 'gp') player.goals = this.parseNum(text);
                        if (header === 'a') player.assists = this.parseNum(text);
                        if (header === 'pts') player.points = this.parseNum(text);
                        if (header === 'sh') player.shots = this.parseNum(text);
                        if (header === 'sv' || header === 'saves') player.saves = this.parseNum(text);
                    });

                    // Determine position
                    if (player.saves > 0) player.position = 'G';
                    else if (player.goals >= 3) player.position = 'A';

                    if (player.name && player.name.length > 2 && !player.name.toLowerCase().includes('total')) {
                        players.push(player);
                    }
                });
            }
        });

        return players;
    }

    createEstimatedTeam(teamName) {
        const variance = (Math.random() - 0.5) * 4;
        return {
            success: false,
            estimated: true,
            team: {
                name: teamName,
                abbrev: this.createAbbrev(teamName),
                record: '2-2',
                wins: 2, losses: 2, games: 4,
                goals: Math.round(36 + variance * 4),
                goalsAllowed: Math.round(36 - variance * 4),
                goalsPerGame: 9 + variance,
                goalsAllowedPerGame: 9 - variance,
                faceoffPct: 0.5 + (Math.random() - 0.5) * 0.1,
                clearPct: 0.75,
                savePct: 0.55
            },
            players: []
        };
    }

    // ═══════════════════════════════════════════════════════════════════
    // SCHEDULE
    // ═══════════════════════════════════════════════════════════════════

    async getSchedule() {
        try {
            const response = await this.client.get(this.IIT_SCHEDULE_URL);
            const $ = cheerio.load(response.data);
            const games = [];

            // Parse schedule from page
            $('.sidearm-schedule-game, li, tr').each((i, el) => {
                const text = $(el).text().replace(/\s+/g, ' ');
                if (text.match(/vs\.?|at\s/i)) {
                    const game = this.parseGameText(text);
                    if (game?.opponent) games.push(game);
                }
            });

            return games.length >= 5 ? games : this.getKnownSchedule();
        } catch (e) {
            return this.getKnownSchedule();
        }
    }

    parseGameText(text) {
        const vsMatch = text.match(/(?:vs\.?|at)\s+([A-Za-z][A-Za-z\s\.\(\)'-]+?)(?:\s+\d|\s+[WL]|$)/i);
        if (!vsMatch) return null;

        const dateMatch = text.match(/((?:Jan|Feb|Mar|Apr|May)[a-z]*\.?\s+\d{1,2})/i);
        const timeMatch = text.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
        const scoreMatch = text.match(/([WL])\s*,?\s*(\d+)-(\d+)/i);

        return {
            opponent: this.cleanTeamName(vsMatch[1]),
            date: dateMatch?.[1] || null,
            time: timeMatch?.[1] || null,
            isHome: !text.toLowerCase().includes(' at '),
            isCompleted: !!scoreMatch,
            result: scoreMatch?.[1]?.toUpperCase() || null,
            iitScore: scoreMatch ? parseInt(scoreMatch[2]) : null,
            oppScore: scoreMatch ? parseInt(scoreMatch[3]) : null
        };
    }

    getKnownSchedule() {
        return [
            { opponent: 'Bridgewater (Va.)', date: 'Feb 13', isCompleted: true, result: 'L', iitScore: 10, oppScore: 11, isHome: false },
            { opponent: 'Transylvania', date: 'Feb 14', isCompleted: true, result: 'L', iitScore: 4, oppScore: 10, isHome: false },
            { opponent: 'Calvin', date: 'Feb 21', isCompleted: true, result: 'L', iitScore: 5, oppScore: 8, isHome: true },
            { opponent: 'Kalamazoo', date: 'Feb 28', isCompleted: true, result: 'L', iitScore: 9, oppScore: 10, isHome: false },
            { opponent: 'DePauw', date: 'Mar 7', time: '2:00 PM', isHome: true, isCompleted: false, isConference: false },
            { opponent: 'Hope', date: 'Mar 11', time: '6:00 PM', isHome: false, isCompleted: false },
            { opponent: 'Beloit', date: 'Mar 18', time: '7:00 PM', isHome: false, isCompleted: false, isConference: true },
            { opponent: 'Edgewood', date: 'Mar 21', time: '12:00 PM', isHome: true, isCompleted: false, isConference: true },
            { opponent: 'Concordia (Wis.)', date: 'Mar 25', time: '4:00 PM', isHome: false, isCompleted: false, isConference: true },
            { opponent: 'Lawrence', date: 'Mar 28', time: '2:00 PM', isHome: false, isCompleted: false, isConference: true },
            { opponent: 'MSOE', date: 'Apr 1', time: '7:00 PM', isHome: true, isCompleted: false, isConference: true },
            { opponent: 'Marian', date: 'Apr 4', time: '3:00 PM', isHome: true, isCompleted: false, isConference: true },
            { opponent: 'Aurora', date: 'Apr 8', time: '4:00 PM', isHome: false, isCompleted: false, isConference: true },
            { opponent: 'Cornell College', date: 'Apr 11', time: '5:00 PM', isHome: false, isCompleted: false, isConference: true },
            { opponent: 'Benedictine', date: 'Apr 15', time: '7:00 PM', isHome: false, isCompleted: false, isConference: true },
            { opponent: 'Dubuque', date: 'Apr 18', time: '4:00 PM', isHome: true, isCompleted: false, isConference: true },
            { opponent: 'Lake Forest', date: 'Apr 22', time: '7:00 PM', isHome: true, isCompleted: false, isConference: true }
        ];
    }

    // ═══════════════════════════════════════════════════════════════════
    // DATABASE OPERATIONS
    // ═══════════════════════════════════════════════════════════════════

    async upsertTeam(stats, sourceUrl) {
        const result = await pool.query(`
            INSERT INTO teams (name, abbrev, record, wins, losses, games, goals, goals_allowed,
                              shots, shot_pct, faceoff_pct, clear_pct, save_pct,
                              goals_per_game, goals_allowed_per_game, source_url, last_scraped)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
            ON CONFLICT (name) DO UPDATE SET
                record = EXCLUDED.record, wins = EXCLUDED.wins, losses = EXCLUDED.losses,
                goals = EXCLUDED.goals, goals_allowed = EXCLUDED.goals_allowed,
                goals_per_game = EXCLUDED.goals_per_game, goals_allowed_per_game = EXCLUDED.goals_allowed_per_game,
                faceoff_pct = EXCLUDED.faceoff_pct, source_url = EXCLUDED.source_url, last_scraped = NOW()
            RETURNING id
        `, [stats.name, stats.abbrev, stats.record, stats.wins, stats.losses, stats.games,
            stats.goals, stats.goalsAllowed, stats.shots, stats.shotPct,
            stats.faceoffPct, stats.clearPct, stats.savePct,
            stats.goalsPerGame, stats.goalsAllowedPerGame, sourceUrl]);
        
        return result.rows[0].id;
    }

    async upsertPlayer(player, teamId) {
        await pool.query(`
            INSERT INTO players (team_id, number, name, position, games_played, goals, assists, points, shots, saves)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT DO NOTHING
        `, [teamId, player.number, player.name, player.position, player.gamesPlayed,
            player.goals, player.assists, player.points, player.shots, player.saves]);
    }

    async storeSchedule(schedule) {
        const iitRes = await pool.query("SELECT id FROM teams WHERE name = 'Illinois Tech'");
        const iitId = iitRes.rows[0]?.id;

        for (const game of schedule) {
            const oppRes = await pool.query("SELECT id FROM teams WHERE LOWER(name) LIKE $1", 
                                           [`%${game.opponent.toLowerCase().split(' ')[0]}%`]);
            const oppId = oppRes.rows[0]?.id;

            let gameDate = null;
            if (game.date) {
                gameDate = new Date(`${game.date} 2026`);
            }

            await pool.query(`
                INSERT INTO games (home_team_id, away_team_id, game_date, game_time, is_home_game,
                                  is_conference, home_score, away_score, is_completed)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT DO NOTHING
            `, [
                game.isHome ? iitId : oppId,
                game.isHome ? oppId : iitId,
                gameDate, game.time, game.isHome, game.isConference || false,
                game.isCompleted ? (game.isHome ? game.iitScore : game.oppScore) : null,
                game.isCompleted ? (game.isHome ? game.oppScore : game.iitScore) : null,
                game.isCompleted || false
            ]);
        }
    }

    async logScrape(url, status, records, error, duration) {
        try {
            await pool.query(`
                INSERT INTO scrape_logs (source_url, status, records_updated, error_message, duration_ms)
                VALUES ($1, $2, $3, $4, $5)
            `, [url, status, records, error, duration]);
        } catch (e) { /* ignore */ }
    }

    // ═══════════════════════════════════════════════════════════════════
    // UTILITIES
    // ═══════════════════════════════════════════════════════════════════

    parseNum(text) {
        const m = text.match(/\d+/);
        return m ? parseInt(m[0]) : 0;
    }

    parsePct(text) {
        const m = text.match(/\.(\d+)/);
        return m ? parseFloat('0.' + m[1]) : null;
    }

    cleanTeamName(name) {
        return name.replace(/\s+/g, ' ').replace(/^(vs\.?|at)\s+/i, '').trim();
    }

    createAbbrev(name) {
        const words = name.replace(/\([^)]+\)/g, '').trim().split(/\s+/);
        return words.length === 1 ? name.substring(0, 3).toUpperCase() 
                                  : words.slice(0, 3).map(w => w[0]).join('').toUpperCase();
    }

    slugify(text) {
        return text.toLowerCase().replace(/[^\w]/g, '').substring(0, 20);
    }

    sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }
}

module.exports = AutonomousScraper;

// Run directly
if (require.main === module) {
    const scraper = new AutonomousScraper();
    scraper.scrapeAll()
        .then(() => process.exit(0))
        .catch(e => { console.error(e); process.exit(1); });
}
