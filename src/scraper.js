const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const pool = require('../config/database');
const oddsEngine = require('./odds-engine');

/**
 * AUTONOMOUS LACROSSE SCRAPER v3.0
 *
 * Discovery order:
 * 1. IIT schedule opponent links
 * 2. Manual overrides
 * 3. Previously stored source URLs
 * 4. Direct stats-path probing and on-site crawling
 * 5. Search engine fallbacks
 * 6. Deterministic estimated stats
 */

class AutonomousScraper {
    constructor() {
        this.client = axios.create({
            timeout: 30000,
            maxRedirects: 5,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });

        this.IIT_SCHEDULE_URL = 'https://illinoistechathletics.com/sports/mlax/schedule';
        this.IIT_STATS_URL = 'https://illinoistechathletics.com/sports/mens-lacrosse/stats';
        this.urlCache = new Map();
        this.teamUrlOverrides = this.loadTeamUrlOverrides();
        this.statsPatterns = [
            '/sports/mens-lacrosse/stats',
            '/sports/mlax/stats',
            '/sports/m-lacros/stats',
            '/sports/mens-lacrosse/2026/stats',
            '/sports/mlax/2026/stats'
        ];
    }

    loadTeamUrlOverrides() {
        const overridesPath = path.join(__dirname, 'team-url-overrides.json');

        try {
            const raw = fs.readFileSync(overridesPath, 'utf8');
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (error) {
            return {};
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // MAIN ENTRY POINT
    // ═══════════════════════════════════════════════════════════════════

    async scrapeAll() {
        console.log('\n' + '═'.repeat(65));
        console.log('🤖 AUTONOMOUS LACROSSE SCRAPER');
        console.log('═'.repeat(65));
        console.log(`Started: ${new Date().toLocaleString()}\n`);

        const results = {
            iit: null,
            opponents: [],
            games: [],
            errors: [],
            generatedOdds: 0,
            generatedProps: 0
        };
        const startTime = Date.now();

        try {
            console.log('┌─ STEP 1: Scraping Illinois Tech');
            results.iit = await this.scrapeTeamFromUrl('Illinois Tech', this.IIT_STATS_URL);
            console.log(`│  ✓ Record: ${results.iit?.team?.record || 'unknown'}\n│`);

            console.log('├─ STEP 2: Fetching Schedule');
            const schedule = await this.getSchedule();
            results.games = schedule;
            console.log(`│  ✓ Found ${schedule.length} games\n│`);

            const seedUrls = new Map();
            for (const game of schedule) {
                const key = this.normalizeTeamName(game.opponent);
                if (game.opponentUrl && !seedUrls.has(key)) {
                    seedUrls.set(key, game.opponentUrl);
                }
            }

            const opponents = [...new Set(schedule.map(game => game.opponent).filter(Boolean))];
            console.log('├─ STEP 3: Scraping Opponents');
            console.log(`│  Found ${opponents.length} unique opponents:\n│`);

            for (let index = 0; index < opponents.length; index++) {
                const opponent = opponents[index];
                console.log(`│  [${index + 1}/${opponents.length}] ${opponent}`);

                try {
                    const result = await this.findAndScrapeTeam(opponent, {
                        seedUrl: seedUrls.get(this.normalizeTeamName(opponent))
                    });

                    results.opponents.push(result);

                    if (result.success) {
                        console.log(`│      ✓ ${result.team?.record || 'OK'} - ${result.players?.length || 0} players`);
                        console.log(`│      URL: ${result.url}`);
                    } else {
                        console.log('│      ⚠ Using deterministic estimates');
                    }
                } catch (error) {
                    console.log(`│      ✗ ${error.message}`);
                    results.errors.push({ team: opponent, error: error.message });
                }

                await this.sleep(1000);
            }

            console.log('│\n├─ STEP 4: Storing Schedule');
            await this.storeSchedule(schedule);
            console.log('│  ✓ Schedule saved\n│');

            console.log('├─ STEP 5: Generating Odds');
            results.generatedOdds = await oddsEngine.generateAllOdds();
            results.generatedProps = await oddsEngine.generateAllPlayerProps();
            console.log(`│  ✓ Game odds: ${results.generatedOdds}`);
            console.log(`│  ✓ Player props: ${results.generatedProps}\n│`);

            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            const successful = results.opponents.filter(result => result.success).length;

            console.log('└─ COMPLETE\n');
            console.log('═'.repeat(65));
            console.log(
                `Duration: ${duration}s | Opponents: ${successful}/${opponents.length} | Games: ${schedule.length} | Odds: ${results.generatedOdds} | Props: ${results.generatedProps}`
            );
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

    async findAndScrapeTeam(teamName, options = {}) {
        const cacheKey = this.normalizeTeamName(teamName);

        if (this.urlCache.has(cacheKey)) {
            return this.scrapeTeamFromUrl(teamName, this.urlCache.get(cacheKey));
        }

        const candidateUrls = this.uniqueUrls([
            options.seedUrl,
            this.getOverrideUrl(teamName),
            await this.getStoredSourceUrl(teamName)
        ]);

        for (const candidateUrl of candidateUrls) {
            const statsUrl = await this.resolveStatsUrl(candidateUrl);
            if (statsUrl) {
                this.urlCache.set(cacheKey, statsUrl);
                return this.scrapeTeamFromUrl(teamName, statsUrl);
            }
        }

        const discoveredUrl = await this.discoverStatsUrl(teamName);
        if (discoveredUrl) {
            this.urlCache.set(cacheKey, discoveredUrl);
            return this.scrapeTeamFromUrl(teamName, discoveredUrl);
        }

        return this.saveEstimatedTeam(teamName);
    }

    getOverrideUrl(teamName) {
        const normalizedTeam = this.normalizeTeamName(teamName);

        for (const [name, url] of Object.entries(this.teamUrlOverrides)) {
            if (this.normalizeTeamName(name) === normalizedTeam) {
                return url;
            }
        }

        return null;
    }

    async getStoredSourceUrl(teamName) {
        try {
            const result = await pool.query(`
                SELECT source_url
                FROM teams
                WHERE LOWER(name) = LOWER($1) AND source_url IS NOT NULL
                ORDER BY last_scraped DESC NULLS LAST, id DESC
                LIMIT 1
            `, [teamName]);

            return result.rows[0]?.source_url || null;
        } catch (error) {
            return null;
        }
    }

    async discoverStatsUrl(teamName) {
        const searchQueries = this.generateSearchQueries(teamName);

        for (const query of searchQueries) {
            const searchResults = [
                ...(await this.searchDuckDuckGo(query)),
                ...(await this.searchBing(query))
            ];

            for (const candidateUrl of this.uniqueUrls(searchResults)) {
                const statsUrl = await this.resolveStatsUrl(candidateUrl);
                if (statsUrl) {
                    return statsUrl;
                }
            }
        }

        return this.tryCommonDomains(teamName);
    }

    async searchDuckDuckGo(query) {
        try {
            const response = await this.fetchPage(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, 10000);
            const $ = cheerio.load(response.data);
            const urls = [];

            $('a.result__a, a.result__url').each((index, element) => {
                const href = $(element).attr('href') || '';
                const url = this.extractUrl(href);
                if (url && this.isAthleticsSite(url)) {
                    urls.push(url);
                }
            });

            return this.uniqueUrls(urls);
        } catch (error) {
            return [];
        }
    }

    async searchBing(query) {
        try {
            const response = await this.fetchPage(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, 10000);
            const $ = cheerio.load(response.data);
            const urls = [];

            $('li.b_algo h2 a').each((index, element) => {
                const href = $(element).attr('href') || '';
                if (href && this.isAthleticsSite(href)) {
                    urls.push(href);
                }
            });

            return this.uniqueUrls(urls);
        } catch (error) {
            return [];
        }
    }

    generateSearchQueries(teamName) {
        const cleanName = teamName.replace(/\([^)]+\)/g, '').trim();
        return [
            `${cleanName} men's lacrosse stats`,
            `${cleanName} athletics men's lacrosse`,
            `${cleanName} lacrosse statistics`
        ];
    }

    isAthleticsSite(url) {
        const lower = url.toLowerCase();
        return lower.includes('athletics')
            || lower.includes('/sports/')
            || lower.includes('sidearmsports')
            || lower.endsWith('.edu')
            || lower.includes('goblue')
            || lower.includes('gomsoe');
    }

    extractUrl(href) {
        if (!href) {
            return null;
        }

        const wrappedMatch = href.match(/uddg=([^&]+)/);
        if (wrappedMatch) {
            return decodeURIComponent(wrappedMatch[1]);
        }

        return href.startsWith('http') ? href : null;
    }

    async resolveStatsUrl(candidateUrl) {
        const cleanedUrl = this.extractUrl(candidateUrl) || candidateUrl;
        if (!cleanedUrl) {
            return null;
        }

        const directMatch = await this.isStatsPage(cleanedUrl);
        if (directMatch) {
            return directMatch;
        }

        const probedMatch = await this.findStatsPage(cleanedUrl);
        if (probedMatch) {
            return probedMatch;
        }

        return this.crawlForStatsPage(cleanedUrl);
    }

    async findStatsPage(baseUrl) {
        if (!baseUrl) {
            return null;
        }

        try {
            const parsed = new URL(baseUrl);
            const origin = `${parsed.protocol}//${parsed.host}`;
            const candidateUrls = new Set();
            const trimmedPath = parsed.pathname.replace(/\/+$/, '');

            candidateUrls.add(origin);

            if (trimmedPath) {
                candidateUrls.add(`${origin}${trimmedPath}`);
                candidateUrls.add(`${origin}${trimmedPath}/stats`);

                const sportsRootMatch = trimmedPath.match(/^(\/sports\/(?:mens-lacrosse|mlax|m-lacros))/i);
                if (sportsRootMatch) {
                    candidateUrls.add(`${origin}${sportsRootMatch[1]}/stats`);
                }
            }

            for (const statsPattern of this.statsPatterns) {
                candidateUrls.add(`${origin}${statsPattern}`);
            }

            for (const candidate of candidateUrls) {
                const resolved = await this.isStatsPage(candidate);
                if (resolved) {
                    return resolved;
                }
            }
        } catch (error) {
            return null;
        }

        return null;
    }

    async crawlForStatsPage(entryUrl) {
        try {
            const response = await this.fetchPage(entryUrl, 8000);
            const finalUrl = response.request?.res?.responseUrl || entryUrl;

            if (this.isValidStatsPage(response.data)) {
                return finalUrl;
            }

            const $ = cheerio.load(response.data);
            const entryHost = new URL(finalUrl).host;
            const candidateLinks = [];

            $('a[href]').each((index, element) => {
                const href = $(element).attr('href');
                const absoluteUrl = this.toAbsoluteUrl(href, finalUrl);

                if (!absoluteUrl) {
                    return;
                }

                try {
                    const parsed = new URL(absoluteUrl);
                    if (parsed.host !== entryHost) {
                        return;
                    }
                } catch (error) {
                    return;
                }

                const searchText = `${$(element).text()} ${href}`.toLowerCase();
                if (searchText.includes('lacrosse') || searchText.includes('mlax') || searchText.includes('stats')) {
                    candidateLinks.push(absoluteUrl);
                }
            });

            for (const candidateUrl of this.uniqueUrls(candidateLinks).slice(0, 12)) {
                const directMatch = await this.isStatsPage(candidateUrl);
                if (directMatch) {
                    return directMatch;
                }

                const nestedMatch = await this.findStatsPage(candidateUrl);
                if (nestedMatch) {
                    return nestedMatch;
                }
            }
        } catch (error) {
            return null;
        }

        return null;
    }

    async isStatsPage(url) {
        try {
            const response = await this.fetchPage(url, 8000);
            if (response.status === 200 && this.isValidStatsPage(response.data)) {
                return response.request?.res?.responseUrl || url;
            }
        } catch (error) {
            return null;
        }

        return null;
    }

    isValidStatsPage(html) {
        const lower = html.toLowerCase();
        return lower.includes('lacrosse')
            && lower.includes('<table')
            && (
                lower.includes('overall team statistics')
                || lower.includes('cumulative statistics')
                || lower.includes('sidearm-table')
                || (lower.includes('goals') && lower.includes('faceoffs'))
            );
    }

    async tryCommonDomains(teamName) {
        const variants = this.slugVariants(teamName);
        const candidateDomains = new Set();

        for (const slug of variants) {
            candidateDomains.add(`https://${slug}athletics.com`);
            candidateDomains.add(`https://www.${slug}athletics.com`);
            candidateDomains.add(`https://athletics.${slug}.edu`);
            candidateDomains.add(`https://athletics.${slug}.com`);
            candidateDomains.add(`https://go${slug}.com`);
            candidateDomains.add(`https://www.go${slug}.com`);
        }

        for (const domain of candidateDomains) {
            const resolved = await this.resolveStatsUrl(domain);
            if (resolved) {
                return resolved;
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
            const response = await this.fetchPage(url);
            const finalUrl = response.request?.res?.responseUrl || url;

            if (!this.isValidStatsPage(response.data)) {
                throw new Error('Resolved URL is not a valid lacrosse stats page');
            }

            const $ = cheerio.load(response.data);
            const team = this.parseTeamStats($, teamName);
            const players = this.parsePlayers($);

            const teamId = await this.upsertTeam(team, finalUrl);
            for (const player of players) {
                await this.upsertPlayer(player, teamId);
            }

            await this.logScrape(finalUrl, 'success', players.length, null, Date.now() - startTime);

            return { success: true, team, players, url: finalUrl };
        } catch (error) {
            await this.logScrape(url, 'error', 0, error.message, Date.now() - startTime);
            return this.saveEstimatedTeam(teamName);
        }
    }

    parseTeamStats($, teamName) {
        const stats = {
            name: teamName,
            abbrev: this.createAbbrev(teamName),
            wins: 0,
            losses: 0,
            games: 0,
            goals: 0,
            goalsAllowed: 0,
            assists: 0,
            shots: 0,
            shotPct: 0,
            faceoffPct: 0.5,
            clearPct: 0.75,
            savePct: 0.55
        };

        const comparisonTable = $('table').filter((index, table) => {
            return $(table).find('#team-team').length > 0 && $(table).find('#team-opponent').length > 0;
        }).first();

        if (comparisonTable.length > 0) {
            const rows = {};
            const findRow = (label) => {
                if (rows[label]) {
                    return rows[label];
                }

                return Object.entries(rows).find(([key]) => key.startsWith(label))?.[1] || null;
            };

            comparisonTable.find('tbody tr').each((index, row) => {
                const cells = $(row).find('td');
                if (cells.length !== 3) {
                    return;
                }

                const label = this.normalizeStatLabel($(cells[0]).text());
                rows[label] = {
                    team: $(cells[1]).text().trim(),
                    opponent: $(cells[2]).text().trim()
                };
            });

            stats.goals = this.parseNum(findRow('goals')?.team) || stats.goals;
            stats.goalsAllowed = this.parseNum(findRow('goals')?.opponent) || stats.goalsAllowed;
            stats.assists = this.parseNum(findRow('assists')?.team) || stats.assists;
            stats.shots = this.parseNum(findRow('shots')?.team) || stats.shots;
            stats.shotPct = this.parsePct(findRow('shot percentage')?.team) ?? stats.shotPct;
            stats.faceoffPct = this.parsePct(findRow('faceoffs percentage')?.team) ?? stats.faceoffPct;
            stats.clearPct = this.parsePct(findRow('clear percentage')?.team) ?? stats.clearPct;
        }

        const scoringTotals = $('#individual-overall-scoring tfoot tr').filter((index, row) => {
            return $(row).text().toLowerCase().includes('totals');
        }).first();

        const scoringOpponents = $('#individual-overall-scoring tfoot tr').filter((index, row) => {
            return $(row).text().toLowerCase().includes('opponents');
        }).first();

        if (scoringTotals.length > 0) {
            stats.games = this.extractGamesPlayed(scoringTotals.find('[data-label="GP-GS"], [data-label="GP"]').first().text()) || stats.games;
            stats.goals = this.parseNum(scoringTotals.find('[data-label="G"]').text()) || stats.goals;
            stats.assists = this.parseNum(scoringTotals.find('[data-label="A"]').text()) || stats.assists;
            stats.shots = this.parseNum(scoringTotals.find('[data-label="SH"]').text()) || stats.shots;
            stats.shotPct = this.parsePct(scoringTotals.find('[data-label="SH%"]').text()) ?? stats.shotPct;
            stats.faceoffPct = this.parsePct(scoringTotals.find('[data-label="FO%"]').text()) ?? stats.faceoffPct;
        }

        if (scoringOpponents.length > 0) {
            stats.goalsAllowed = this.parseNum(scoringOpponents.find('[data-label="G"]').text()) || stats.goalsAllowed;
        }

        const goalkeepingTotals = $('#individual-overall-goalkeeping tfoot tr').filter((index, row) => {
            return $(row).text().toLowerCase().includes('totals');
        }).first();

        if (goalkeepingTotals.length > 0) {
            stats.savePct = this.parsePct(goalkeepingTotals.find('[data-label="SV%"]').text()) ?? stats.savePct;
            stats.wins = this.parseNum(goalkeepingTotals.find('[data-label="W"]').text()) || stats.wins;
            stats.losses = this.parseNum(goalkeepingTotals.find('[data-label="L"]').text()) || stats.losses;
        }

        if (!stats.wins && !stats.losses) {
            const pageText = $('body').text();
            const recordMatch = pageText.match(/\((\d+)-(\d+)(?:-\d+)?\)/);
            if (recordMatch) {
                stats.wins = parseInt(recordMatch[1], 10);
                stats.losses = parseInt(recordMatch[2], 10);
            }
        }

        if (!stats.games) {
            stats.games = Math.max(stats.wins + stats.losses, 1);
        }

        stats.record = `${stats.wins}-${stats.losses}`;
        stats.goalsPerGame = stats.games ? stats.goals / stats.games : 0;
        stats.goalsAllowedPerGame = stats.games ? stats.goalsAllowed / stats.games : 0;

        return stats;
    }

    parsePlayers($) {
        const sidearmPlayers = this.parseSidearmPlayers($);
        if (sidearmPlayers.length > 0) {
            return sidearmPlayers;
        }

        return this.parseGenericPlayers($);
    }

    parseSidearmPlayers($) {
        const players = [];
        const playersByName = new Map();

        $('#individual-overall-scoring tbody tr').each((index, row) => {
            const player = {
                number: $(row).find('td').eq(0).text().trim(),
                name: this.extractPlayerName($(row)),
                position: 'M',
                gamesPlayed: this.extractGamesPlayed($(row).find('[data-label="GP-GS"]').text()),
                goals: this.parseNum($(row).find('[data-label="G"]').text()),
                assists: this.parseNum($(row).find('[data-label="A"]').text()),
                points: this.parseNum($(row).find('[data-label="PTS"]').text()),
                shots: this.parseNum($(row).find('[data-label="SH"]').text()),
                saves: 0,
                faceoffPct: this.parsePct($(row).find('[data-label="FO%"]').text()) || 0
            };

            if (!this.isValidPlayer(player.name)) {
                return;
            }

            if (player.goals >= 3) {
                player.position = 'A';
            } else if (player.faceoffPct >= 0.4) {
                player.position = 'FO';
            }

            playersByName.set(player.name.toLowerCase(), player);
        });

        $('#individual-overall-goalkeeping tbody tr').each((index, row) => {
            const name = this.extractPlayerName($(row));
            if (!this.isValidPlayer(name)) {
                return;
            }

            const goalie = playersByName.get(name.toLowerCase()) || {
                number: $(row).find('td').eq(0).text().trim(),
                name,
                position: 'G',
                gamesPlayed: this.extractGamesPlayed($(row).find('[data-label="GP-GS"], [data-label="GP"]').text()),
                goals: 0,
                assists: 0,
                points: 0,
                shots: 0,
                saves: 0,
                faceoffPct: 0
            };

            goalie.position = 'G';
            goalie.saves = this.parseNum($(row).find('[data-label="SV"]').text()) || goalie.saves;
            goalie.gamesPlayed = this.extractGamesPlayed($(row).find('[data-label="GP-GS"], [data-label="GP"]').text()) || goalie.gamesPlayed;
            playersByName.set(name.toLowerCase(), goalie);
        });

        for (const player of playersByName.values()) {
            players.push(player);
        }

        return players;
    }

    parseGenericPlayers($) {
        const players = [];

        $('table').each((index, table) => {
            const headers = $(table).find('th').map((cellIndex, header) => {
                return $(header).text().trim().toLowerCase();
            }).get();

            const hasPlayerNames = headers.some(header => header.includes('player') || header.includes('name'));
            const hasScoring = headers.some(header => ['g', 'a', 'pts', 'goals'].includes(header));

            if (!hasPlayerNames && !hasScoring) {
                return;
            }

            $(table).find('tbody tr, tr').each((rowIndex, row) => {
                const cells = $(row).find('td');
                if (cells.length < 3) {
                    return;
                }

                const player = {
                    number: '',
                    name: '',
                    position: 'M',
                    gamesPlayed: 0,
                    goals: 0,
                    assists: 0,
                    points: 0,
                    shots: 0,
                    saves: 0,
                    faceoffPct: 0
                };

                cells.each((cellIndex, cell) => {
                    const text = $(cell).text().trim();
                    const header = headers[cellIndex] || '';

                    if (header === '#' || cellIndex === 0) player.number = text.match(/\d+/)?.[0] || '';
                    if (header.includes('name') || header.includes('player') || cellIndex === 1) {
                        player.name = text.replace(/view bio/i, '').trim();
                    }
                    if (header === 'gp' || header === 'gp-gs') player.gamesPlayed = this.extractGamesPlayed(text);
                    if (header === 'g' || header === 'goals') player.goals = this.parseNum(text);
                    if (header === 'a') player.assists = this.parseNum(text);
                    if (header === 'pts') player.points = this.parseNum(text);
                    if (header === 'sh' || header === 'shots') player.shots = this.parseNum(text);
                    if (header === 'sv' || header === 'saves') player.saves = this.parseNum(text);
                    if (header === 'fo%' || header === 'faceoff %') player.faceoffPct = this.parsePct(text) || 0;
                });

                if (player.saves > 0) player.position = 'G';
                else if (player.goals >= 3) player.position = 'A';
                else if (player.faceoffPct >= 0.4) player.position = 'FO';

                if (this.isValidPlayer(player.name)) {
                    players.push(player);
                }
            });
        });

        return players;
    }

    extractPlayerName(row) {
        return row.find('a[data-player-id]').first().text().trim()
            || row.find('span.hide-on-large').first().text().trim()
            || row.find('td').eq(1).text().replace(/view bio/i, '').trim();
    }

    isValidPlayer(name) {
        return !!name
            && name.length > 2
            && !name.toLowerCase().includes('total')
            && !name.toLowerCase().includes('opponents')
            && name.toLowerCase() !== 'team';
    }

    async saveEstimatedTeam(teamName) {
        const estimated = this.createEstimatedTeam(teamName);
        await this.upsertTeam(estimated.team, null);
        return estimated;
    }

    createEstimatedTeam(teamName) {
        const seed = this.deterministicNumber(this.normalizeTeamName(teamName));
        const variance = ((seed % 9) - 4) / 2;
        const faceoffBase = 0.46 + ((seed % 11) / 100);
        const clearBase = 0.72 + ((seed % 7) / 100);
        const saveBase = 0.52 + ((seed % 9) / 100);

        return {
            success: false,
            estimated: true,
            url: null,
            team: {
                name: teamName,
                abbrev: this.createAbbrev(teamName),
                record: '2-2',
                wins: 2,
                losses: 2,
                games: 4,
                goals: Math.round(36 + variance * 4),
                goalsAllowed: Math.round(36 - variance * 4),
                goalsPerGame: 9 + variance,
                goalsAllowedPerGame: 9 - variance,
                shots: Math.round(110 + variance * 8),
                shotPct: 0.25,
                faceoffPct: Math.max(0.35, Math.min(faceoffBase, 0.65)),
                clearPct: Math.max(0.6, Math.min(clearBase, 0.9)),
                savePct: Math.max(0.45, Math.min(saveBase, 0.75))
            },
            players: []
        };
    }

    // ═══════════════════════════════════════════════════════════════════
    // SCHEDULE
    // ═══════════════════════════════════════════════════════════════════

    async getSchedule() {
        try {
            const response = await this.fetchPage(this.IIT_SCHEDULE_URL);
            const $ = cheerio.load(response.data);
            const seasonYear = this.extractSeasonYear($);
            const games = this.parseSchedulePage($, seasonYear);

            if (games.length >= 5) {
                return games;
            }

            const fallbackGames = this.parseScheduleJsonLd($);
            return fallbackGames.length >= 5 ? fallbackGames : this.getKnownSchedule();
        } catch (error) {
            return this.getKnownSchedule();
        }
    }

    parseSchedulePage($, seasonYear) {
        const games = [];

        $('li.sidearm-schedule-game').each((index, element) => {
            const gameNode = $(element);
            const dateParts = gameNode.find('.sidearm-schedule-game-opponent-date span');
            const opponentLink = gameNode.find('.sidearm-schedule-game-opponent-name a').first();
            const opponent = this.cleanTeamName(
                opponentLink.text() || gameNode.find('.sidearm-schedule-game-opponent-name').text()
            );

            if (!opponent) {
                return;
            }

            const dateText = dateParts.eq(0).text().trim();
            const timeText = dateParts.eq(1).text().trim() || null;
            const resultText = gameNode.find('.sidearm-schedule-game-result').text().replace(/\s+/g, ' ').trim();
            const scoreMatch = resultText.match(/([WL]),?\s*(\d+)-(\d+)/i);
            const venueText = gameNode.find('.sidearm-schedule-game-conference-vs').text().toLowerCase();

            games.push({
                opponent,
                opponentUrl: this.toAbsoluteUrl(opponentLink.attr('href'), this.IIT_SCHEDULE_URL),
                date: dateText,
                time: timeText,
                location: gameNode.find('.sidearm-schedule-game-location span').first().text().trim() || null,
                seasonYear,
                isHome: !gameNode.hasClass('sidearm-schedule-away-game') && !venueText.includes('at'),
                isConference: gameNode.find('.sidearm-schedule-game-conference').text().toLowerCase().includes('nacc')
                    || gameNode.find('.sidearm-schedule-game-conference-small').length > 0,
                isCompleted: gameNode.hasClass('sidearm-schedule-game-completed') || !!scoreMatch,
                result: scoreMatch?.[1]?.toUpperCase() || null,
                iitScore: scoreMatch ? parseInt(scoreMatch[2], 10) : null,
                oppScore: scoreMatch ? parseInt(scoreMatch[3], 10) : null
            });
        });

        return games;
    }

    parseScheduleJsonLd($) {
        const games = [];

        $('script[type="application/ld+json"]').each((index, script) => {
            const raw = $(script).html();
            if (!raw || !raw.includes('"@type":"SportsEvent"')) {
                return;
            }

            try {
                const parsed = JSON.parse(raw);
                const events = Array.isArray(parsed) ? parsed : [parsed];

                for (const event of events) {
                    if (event['@type'] !== 'SportsEvent') {
                        continue;
                    }

                    const isHome = event.name?.toLowerCase().includes(' vs ');
                    const opponent = this.cleanTeamName(isHome ? event.awayTeam?.name : event.awayTeam?.name);
                    if (!opponent) {
                        continue;
                    }

                    const startDate = event.startDate ? new Date(event.startDate) : null;
                    games.push({
                        opponent,
                        opponentUrl: event.awayTeam?.sameAs || null,
                        date: startDate ? startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null,
                        time: startDate ? startDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : null,
                        location: event.location?.name || null,
                        seasonYear: startDate ? startDate.getFullYear() : new Date().getFullYear(),
                        isHome,
                        isConference: false,
                        isCompleted: false,
                        result: null,
                        iitScore: null,
                        oppScore: null
                    });
                }
            } catch (error) {
                return;
            }
        });

        return games;
    }

    extractSeasonYear($) {
        const canonical = $('link[rel="canonical"]').attr('href') || '';
        const canonicalMatch = canonical.match(/\/schedule\/(\d{4})/);
        if (canonicalMatch) {
            return parseInt(canonicalMatch[1], 10);
        }

        const title = $('title').text();
        const titleMatch = title.match(/(\d{4})\s+Men'?s Lacrosse Schedule/i);
        if (titleMatch) {
            return parseInt(titleMatch[1], 10);
        }

        return new Date().getFullYear();
    }

    getKnownSchedule() {
        return [
            { opponent: 'Bridgewater College', date: 'Feb 13', time: '2:00 PM', seasonYear: 2026, isCompleted: true, result: 'L', iitScore: 10, oppScore: 11, isHome: true, isConference: false },
            { opponent: 'Transylvania University', date: 'Feb 14', time: '1:30 PM', seasonYear: 2026, isCompleted: true, result: 'L', iitScore: 4, oppScore: 10, isHome: true, isConference: false },
            { opponent: 'Calvin University', date: 'Feb 21', time: '1:00 PM', seasonYear: 2026, isCompleted: true, result: 'L', iitScore: 5, oppScore: 8, isHome: true, isConference: false },
            { opponent: 'Kalamazoo College', date: 'Feb 28', time: '12:00 PM', seasonYear: 2026, isCompleted: true, result: 'L', iitScore: 9, oppScore: 10, isHome: false, isConference: false },
            { opponent: 'DePauw University', date: 'Mar 7', time: '2:00 PM', seasonYear: 2026, isHome: true, isCompleted: false, isConference: false },
            { opponent: 'Hope College', date: 'Mar 11', time: '6:00 PM', seasonYear: 2026, isHome: false, isCompleted: false, isConference: false },
            { opponent: 'Beloit College', date: 'Mar 18', time: '7:00 PM', seasonYear: 2026, isHome: false, isCompleted: false, isConference: true },
            { opponent: 'Edgewood University', date: 'Mar 21', time: '12:00 PM', seasonYear: 2026, isHome: true, isCompleted: false, isConference: true },
            { opponent: 'Concordia University (Wis.)', date: 'Mar 25', time: '4:00 PM', seasonYear: 2026, isHome: false, isCompleted: false, isConference: true },
            { opponent: 'Lawrence University', date: 'Mar 28', time: '2:00 PM', seasonYear: 2026, isHome: false, isCompleted: false, isConference: true },
            { opponent: 'Milwaukee School of Engineering', date: 'Apr 1', time: '7:00 PM', seasonYear: 2026, isHome: true, isCompleted: false, isConference: true },
            { opponent: 'Marian University', date: 'Apr 4', time: '3:00 PM', seasonYear: 2026, isHome: true, isCompleted: false, isConference: true },
            { opponent: 'Aurora University', date: 'Apr 8', time: '4:00 PM', seasonYear: 2026, isHome: false, isCompleted: false, isConference: true },
            { opponent: 'Cornell College', date: 'Apr 11', time: '5:00 PM', seasonYear: 2026, isHome: false, isCompleted: false, isConference: true },
            { opponent: 'Benedictine University', date: 'Apr 15', time: '7:00 PM', seasonYear: 2026, isHome: false, isCompleted: false, isConference: true },
            { opponent: 'University of Dubuque', date: 'Apr 18', time: '4:00 PM', seasonYear: 2026, isHome: true, isCompleted: false, isConference: true },
            { opponent: 'Lake Forest College', date: 'Apr 22', time: '7:00 PM', seasonYear: 2026, isHome: true, isCompleted: false, isConference: true }
        ];
    }

    // ═══════════════════════════════════════════════════════════════════
    // DATABASE OPERATIONS
    // ═══════════════════════════════════════════════════════════════════

    async upsertTeam(stats, sourceUrl) {
        const existing = await pool.query(`
            SELECT id, source_url
            FROM teams
            WHERE LOWER(name) = LOWER($1)
            ORDER BY last_scraped DESC NULLS LAST, id DESC
            LIMIT 1
        `, [stats.name]);

        if (existing.rows.length > 0) {
            const result = await pool.query(`
                UPDATE teams
                SET abbrev = $1,
                    record = $2,
                    wins = $3,
                    losses = $4,
                    games = $5,
                    goals = $6,
                    goals_allowed = $7,
                    assists = $8,
                    shots = $9,
                    shot_pct = $10,
                    faceoff_pct = $11,
                    clear_pct = $12,
                    save_pct = $13,
                    goals_per_game = $14,
                    goals_allowed_per_game = $15,
                    source_url = COALESCE($16, source_url),
                    last_scraped = NOW(),
                    updated_at = NOW()
                WHERE id = $17
                RETURNING id
            `, [
                stats.abbrev,
                stats.record,
                stats.wins,
                stats.losses,
                stats.games,
                stats.goals,
                stats.goalsAllowed,
                stats.assists || 0,
                stats.shots,
                stats.shotPct,
                stats.faceoffPct,
                stats.clearPct,
                stats.savePct,
                stats.goalsPerGame,
                stats.goalsAllowedPerGame,
                sourceUrl,
                existing.rows[0].id
            ]);

            return result.rows[0].id;
        }

        const result = await pool.query(`
            INSERT INTO teams (
                name, abbrev, record, wins, losses, games, goals, goals_allowed,
                assists, shots, shot_pct, faceoff_pct, clear_pct, save_pct,
                goals_per_game, goals_allowed_per_game, source_url, last_scraped
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
            RETURNING id
        `, [
            stats.name,
            stats.abbrev,
            stats.record,
            stats.wins,
            stats.losses,
            stats.games,
            stats.goals,
            stats.goalsAllowed,
            stats.assists || 0,
            stats.shots,
            stats.shotPct,
            stats.faceoffPct,
            stats.clearPct,
            stats.savePct,
            stats.goalsPerGame,
            stats.goalsAllowedPerGame,
            sourceUrl
        ]);

        return result.rows[0].id;
    }

    async upsertPlayer(player, teamId) {
        const existing = await pool.query(`
            SELECT id
            FROM players
            WHERE team_id = $1 AND LOWER(name) = LOWER($2)
            ORDER BY updated_at DESC NULLS LAST, id DESC
            LIMIT 1
        `, [teamId, player.name]);

        if (existing.rows.length > 0) {
            await pool.query(`
                UPDATE players
                SET number = $1,
                    position = $2,
                    games_played = $3,
                    goals = $4,
                    assists = $5,
                    points = $6,
                    shots = $7,
                    saves = $8,
                    faceoff_pct = $9,
                    updated_at = NOW()
                WHERE id = $10
            `, [
                player.number || null,
                player.position,
                player.gamesPlayed,
                player.goals,
                player.assists,
                player.points,
                player.shots,
                player.saves,
                player.faceoffPct || null,
                existing.rows[0].id
            ]);
            return existing.rows[0].id;
        }

        const result = await pool.query(`
            INSERT INTO players (
                team_id, number, name, position, games_played,
                goals, assists, points, shots, saves, faceoff_pct
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING id
        `, [
            teamId,
            player.number || null,
            player.name,
            player.position,
            player.gamesPlayed,
            player.goals,
            player.assists,
            player.points,
            player.shots,
            player.saves,
            player.faceoffPct || null
        ]);

        return result.rows[0].id;
    }

    async storeSchedule(schedule) {
        const teamsResult = await pool.query('SELECT id, name FROM teams');
        const teamsByName = new Map(
            teamsResult.rows.map(team => [this.normalizeTeamName(team.name), team.id])
        );

        const iitId = teamsByName.get(this.normalizeTeamName('Illinois Tech'));
        if (!iitId) {
            throw new Error('Illinois Tech team must exist before storing schedule');
        }

        for (const game of schedule) {
            let opponentId = teamsByName.get(this.normalizeTeamName(game.opponent));

            if (!opponentId) {
                await this.saveEstimatedTeam(game.opponent);
                const opponentResult = await pool.query(`
                    SELECT id
                    FROM teams
                    WHERE LOWER(name) = LOWER($1)
                    ORDER BY last_scraped DESC NULLS LAST, id DESC
                    LIMIT 1
                `, [game.opponent]);

                opponentId = opponentResult.rows[0]?.id || null;
                if (opponentId) {
                    teamsByName.set(this.normalizeTeamName(game.opponent), opponentId);
                }
            }

            if (!opponentId) {
                continue;
            }

            const gameDate = this.parseScheduleDate(game.date, game.seasonYear);
            if (!gameDate) {
                continue;
            }

            const homeTeamId = game.isHome ? iitId : opponentId;
            const awayTeamId = game.isHome ? opponentId : iitId;
            const homeScore = game.isCompleted ? (game.isHome ? game.iitScore : game.oppScore) : null;
            const awayScore = game.isCompleted ? (game.isHome ? game.oppScore : game.iitScore) : null;

            const existing = await pool.query(`
                SELECT id
                FROM games
                WHERE home_team_id = $1 AND away_team_id = $2 AND game_date = $3
                ORDER BY updated_at DESC NULLS LAST, id DESC
                LIMIT 1
            `, [homeTeamId, awayTeamId, gameDate]);

            if (existing.rows.length > 0) {
                await pool.query(`
                    UPDATE games
                    SET game_time = $1,
                        location = $2,
                        is_home_game = $3,
                        is_conference = $4,
                        home_score = $5,
                        away_score = $6,
                        is_completed = $7,
                        updated_at = NOW()
                    WHERE id = $8
                `, [
                    game.time || null,
                    game.location || null,
                    game.isHome,
                    game.isConference || false,
                    homeScore,
                    awayScore,
                    game.isCompleted || false,
                    existing.rows[0].id
                ]);
                continue;
            }

            await pool.query(`
                INSERT INTO games (
                    home_team_id, away_team_id, game_date, game_time, location,
                    is_home_game, is_conference, home_score, away_score, is_completed
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [
                homeTeamId,
                awayTeamId,
                gameDate,
                game.time || null,
                game.location || null,
                game.isHome,
                game.isConference || false,
                homeScore,
                awayScore,
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
        } catch (logError) {
            return;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // UTILITIES
    // ═══════════════════════════════════════════════════════════════════

    async fetchPage(url, timeout = 30000) {
        return this.client.get(url, {
            timeout,
            validateStatus: status => status >= 200 && status < 400
        });
    }

    parseNum(text) {
        const match = String(text || '').match(/-?\d+/);
        return match ? parseInt(match[0], 10) : 0;
    }

    parsePct(text) {
        const value = String(text || '').trim();
        if (!value) {
            return null;
        }

        const match = value.match(/-?(?:\d+\.\d+|\.\d+|\d+)/);
        if (!match) {
            return null;
        }

        const normalizedValue = match[0].startsWith('.') ? `0${match[0]}` : match[0];
        const parsed = parseFloat(normalizedValue);
        if (!Number.isFinite(parsed)) {
            return null;
        }

        return value.includes('%') || parsed > 1 ? parsed / 100 : parsed;
    }

    extractGamesPlayed(text) {
        if (!text) {
            return 0;
        }

        const cleaned = String(text).trim();
        const splitMatch = cleaned.match(/^(\d+)-\d+$/);
        if (splitMatch) {
            return parseInt(splitMatch[1], 10);
        }

        return this.parseNum(cleaned);
    }

    cleanTeamName(name) {
        return String(name || '')
            .replace(/\s+/g, ' ')
            .replace(/^(vs\.?|at)\s+/i, '')
            .trim();
    }

    createAbbrev(name) {
        const words = name.replace(/\([^)]+\)/g, '').trim().split(/\s+/);
        if (words.length === 1) {
            return name.substring(0, 4).toUpperCase();
        }

        return words.slice(0, 4).map(word => word[0]).join('').toUpperCase();
    }

    slugify(text) {
        return this.normalizeTeamName(text).replace(/\s+/g, '');
    }

    slugVariants(text) {
        const stripped = String(text || '')
            .replace(/\b(university|college|the)\b/gi, '')
            .replace(/[()'.&]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        return [...new Set([
            this.slugify(text),
            this.slugify(stripped),
            this.createAbbrev(stripped).toLowerCase()
        ].filter(Boolean))];
    }

    normalizeTeamName(name) {
        return String(name || '')
            .toLowerCase()
            .replace(/&/g, ' and ')
            .replace(/[().,'/-]/g, ' ')
            .replace(/\b(the|university|college)\b/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    normalizeStatLabel(text) {
        return String(text || '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .replace(/[():]/g, '')
            .trim();
    }

    parseScheduleDate(dateText, seasonYear) {
        if (!dateText) {
            return null;
        }

        const cleanedDate = String(dateText).replace(/\([^)]*\)/g, '').trim();
        const parsed = new Date(`${cleanedDate} ${seasonYear}`);

        if (Number.isNaN(parsed.getTime())) {
            return null;
        }

        return parsed.toISOString().slice(0, 10);
    }

    uniqueUrls(urls) {
        return [...new Set(
            (urls || [])
                .filter(Boolean)
                .map(url => String(url).trim())
                .filter(Boolean)
        )];
    }

    toAbsoluteUrl(url, baseUrl) {
        if (!url) {
            return null;
        }

        try {
            return new URL(url, baseUrl).toString();
        } catch (error) {
            return null;
        }
    }

    deterministicNumber(text) {
        let hash = 0;
        for (const char of String(text || '')) {
            hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
        }
        return hash;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = AutonomousScraper;

if (require.main === module) {
    const scraper = new AutonomousScraper();
    scraper.scrapeAll()
        .then(() => process.exit(0))
        .catch(error => {
            console.error(error);
            process.exit(1);
        });
}
