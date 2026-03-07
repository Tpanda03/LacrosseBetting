const pool = require('../config/database');
const playerRatings = require('./player-ratings');

class OddsEngine {
    toNumber(value, fallback = 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    /**
     * Calculate win probability using multiple factors
     */
    calculateWinProbability(team1, team2) {
        const t1Games = this.toNumber(team1.games, 0);
        const t2Games = this.toNumber(team2.games, 0);
        const t1GPG = this.toNumber(team1.goals_per_game, t1Games ? this.toNumber(team1.goals) / t1Games : 7);
        const t1GAPG = this.toNumber(team1.goals_allowed_per_game, t1Games ? this.toNumber(team1.goals_allowed) / t1Games : 10);
        const t2GPG = this.toNumber(team2.goals_per_game, t2Games ? this.toNumber(team2.goals) / t2Games : 9);
        const t2GAPG = this.toNumber(team2.goals_allowed_per_game, t2Games ? this.toNumber(team2.goals_allowed) / t2Games : 9);

        // Expected goals per team
        const t1Expected = (t1GPG + t2GAPG) / 2;
        const t2Expected = (t2GPG + t1GAPG) / 2;

        // Win percentage factor
        const t1Wins = this.toNumber(team1.wins, 0);
        const t1Losses = this.toNumber(team1.losses, 0);
        const t2Wins = this.toNumber(team2.wins, 0);
        const t2Losses = this.toNumber(team2.losses, 0);
        const t1WinPct = (t1Wins + t1Losses) > 0 ? t1Wins / (t1Wins + t1Losses) : 0.5;
        const t2WinPct = (t2Wins + t2Losses) > 0 ? t2Wins / (t2Wins + t2Losses) : 0.5;

        // Faceoff advantage
        const faceoffAdj1 = this.toNumber(team1.faceoff_pct, 0.5) * 0.15;
        const faceoffAdj2 = this.toNumber(team2.faceoff_pct, 0.5) * 0.15;

        // Combined power score
        const t1Score = (t1Expected * 0.35) + (t1WinPct * 0.35) + faceoffAdj1 + (this.toNumber(team1.clear_pct, 0.75) * 0.15);
        const t2Score = (t2Expected * 0.35) + (t2WinPct * 0.35) + faceoffAdj2 + (this.toNumber(team2.clear_pct, 0.75) * 0.15);

        const totalScore = t1Score + t2Score;
        const probability = totalScore > 0 ? t1Score / totalScore : 0.5;
        return Math.min(0.99, Math.max(0.01, probability));
    }

    /**
     * Convert probability to American odds
     */
    probabilityToAmerican(prob) {
        prob = Math.min(0.99, Math.max(0.01, prob));
        if (prob >= 0.5) {
            return Math.round(-100 * prob / (1 - prob));
        }
        return Math.round(100 * (1 - prob) / prob);
    }

    americanToProbability(odds) {
        const value = this.toNumber(odds, null);
        if (value === null || value === 0) {
            return null;
        }

        if (value < 0) {
            return Math.abs(value) / (Math.abs(value) + 100);
        }

        return 100 / (value + 100);
    }

    roundToHalf(value) {
        return Math.round(value * 2) / 2;
    }

    /**
     * Calculate point spread
     */
    calculateSpread(team1, team2) {
        const t1GPG = this.toNumber(team1.goals_per_game, 7);
        const t2GPG = this.toNumber(team2.goals_per_game, 9);
        const t1GAPG = this.toNumber(team1.goals_allowed_per_game, 10);
        const t2GAPG = this.toNumber(team2.goals_allowed_per_game, 9);

        const t1Expected = (t1GPG + t2GAPG) / 2;
        const t2Expected = (t2GPG + t1GAPG) / 2;

        return (t1Expected - t2Expected).toFixed(1);
    }

    calculateSpreadMagnitudeFromProbability(probability, totalLine) {
        const favoriteProbability = Math.min(0.99, Math.max(0.5, this.toNumber(probability, 0.5)));
        const probabilityEdge = Math.abs(favoriteProbability - 0.5);
        const magnitudeFromProbability = this.roundToHalf(Math.max(0.5, probabilityEdge * 14));
        const totalCap = totalLine !== null && totalLine !== undefined
            ? Math.max(1.5, this.roundToHalf(this.toNumber(totalLine, 16) * 0.35))
            : 6.0;

        return Math.min(totalCap, magnitudeFromProbability);
    }

    normalizeSpreadFromMoneyline({
        homeMoneyline,
        awayMoneyline,
        totalLine,
        homeWinProb,
        rawSpread
    }) {
        const homeProbability = this.americanToProbability(homeMoneyline);
        const awayProbability = this.americanToProbability(awayMoneyline);
        const fallbackHomeProbability = Math.min(0.99, Math.max(0.01, this.toNumber(homeWinProb, 50) / 100));

        const resolvedHomeProbability = homeProbability ?? fallbackHomeProbability;
        const resolvedAwayProbability = awayProbability ?? (1 - fallbackHomeProbability);
        const homeIsFavorite = resolvedHomeProbability >= resolvedAwayProbability;
        const favoriteProbability = Math.max(resolvedHomeProbability, resolvedAwayProbability);
        const probabilitySpread = this.calculateSpreadMagnitudeFromProbability(favoriteProbability, totalLine);
        const rawMagnitude = Math.abs(this.toNumber(rawSpread, probabilitySpread));
        const spreadMagnitude = this.roundToHalf((probabilitySpread * 0.8) + (Math.min(probabilitySpread, rawMagnitude) * 0.2));

        return homeIsFavorite ? -spreadMagnitude : spreadMagnitude;
    }

    /**
     * Calculate total (over/under) line
     */
    calculateTotal(team1, team2) {
        const t1GPG = this.toNumber(team1.goals_per_game, 7);
        const t2GPG = this.toNumber(team2.goals_per_game, 9);
        const t1GAPG = this.toNumber(team1.goals_allowed_per_game, 10);
        const t2GAPG = this.toNumber(team2.goals_allowed_per_game, 9);

        const expected = ((t1GPG + t2GAPG) / 2) + ((t2GPG + t1GAPG) / 2);
        return (Math.round(expected * 2) / 2).toFixed(1);
    }

    /**
     * Generate full odds for a game
     */
    generateGameOdds(homeTeam, awayTeam) {
        const homeWinProb = this.calculateWinProbability(homeTeam, awayTeam);
        const awayWinProb = 1 - homeWinProb;

        // Add home field advantage (~3%)
        const adjustedHomeProb = Math.min(0.95, homeWinProb + 0.03);
        const adjustedAwayProb = 1 - adjustedHomeProb;
        const homeMoneyline = this.probabilityToAmerican(adjustedHomeProb);
        const awayMoneyline = this.probabilityToAmerican(adjustedAwayProb);
        const totalLine = parseFloat(this.calculateTotal(homeTeam, awayTeam));
        const rawSpread = parseFloat(this.calculateSpread(homeTeam, awayTeam));
        const spreadLine = this.normalizeSpreadFromMoneyline({
            homeMoneyline,
            awayMoneyline,
            totalLine,
            homeWinProb: adjustedHomeProb * 100,
            rawSpread
        });

        return {
            homeMoneyline,
            awayMoneyline,
            spreadLine,
            spreadOdds: -110,
            totalLine,
            overOdds: -110,
            underOdds: -110,
            homeWinProb: (adjustedHomeProb * 100).toFixed(1),
            awayWinProb: (adjustedAwayProb * 100).toFixed(1)
        };
    }

    /**
     * Generate player prop odds
     */
    generatePlayerProps(player, gameId) {
        const props = [];
        const gp = Math.max(this.toNumber(player.games_played, 0), 1);
        const goals = this.toNumber(player.goals, 0);
        const assists = this.toNumber(player.assists, 0);
        const points = this.toNumber(player.points, 0);
        const shots = this.toNumber(player.shots, 0);
        const groundBalls = this.toNumber(player.ground_balls, 0);
        const turnovers = this.toNumber(player.turnovers, 0);
        const causedTurnovers = this.toNumber(player.caused_turnovers, 0);
        const saves = this.toNumber(player.saves, 0);
        const faceoffPct = this.toNumber(player.faceoff_pct, 0);
        const playerRating = playerRatings.calculate(player);
        const ratingAdjustment = Math.max(-0.04, Math.min(0.08, (playerRating - 4) * 0.01));

        // Goals prop for attackers/midfielders
        if (goals > 0 || ['A', 'M'].includes(player.position)) {
            const gpg = goals / gp;
            const line = Math.max(0.5, Math.round(gpg * 2) / 2);
            const overProb = Math.min(0.62, Math.max(0.38, (gpg > line ? 0.55 : 0.45) + ratingAdjustment));

            props.push({
                playerId: player.id,
                gameId: gameId,
                propType: 'Goals',
                line: line,
                overOdds: this.probabilityToAmerican(overProb),
                underOdds: this.probabilityToAmerican(1 - overProb)
            });
        }

        // Points prop
        if (points > 0) {
            const ppg = points / gp;
            const line = Math.max(0.5, Math.round(ppg * 2) / 2);
            const overProb = Math.min(0.62, Math.max(0.38, (ppg > line ? 0.55 : 0.45) + ratingAdjustment));

            props.push({
                playerId: player.id,
                gameId: gameId,
                propType: 'Points',
                line: line,
                overOdds: this.probabilityToAmerican(overProb),
                underOdds: this.probabilityToAmerican(1 - overProb)
            });
        }

        if (assists > 0) {
            const apg = assists / gp;
            const line = Math.max(0.5, Math.round(apg * 2) / 2);
            const overProb = Math.min(0.6, Math.max(0.4, (apg > line ? 0.54 : 0.46) + (ratingAdjustment * 0.8)));

            props.push({
                playerId: player.id,
                gameId: gameId,
                propType: 'Assists',
                line,
                overOdds: this.probabilityToAmerican(overProb),
                underOdds: this.probabilityToAmerican(1 - overProb)
            });
        }

        // Shots prop
        if (shots > 2) {
            const spg = shots / gp;
            const line = Math.max(1.5, Math.round(spg));

            props.push({
                playerId: player.id,
                gameId: gameId,
                propType: 'Shots',
                line: line,
                overOdds: -115,
                underOdds: -105
            });
        }

        if (groundBalls > 0) {
            const gbpg = groundBalls / gp;
            const line = Math.max(0.5, this.roundToHalf(gbpg));

            props.push({
                playerId: player.id,
                gameId: gameId,
                propType: 'Ground Balls',
                line,
                overOdds: -110,
                underOdds: -110
            });
        }

        if (causedTurnovers > 0) {
            const ctpg = causedTurnovers / gp;
            const line = Math.max(0.5, this.roundToHalf(ctpg));

            props.push({
                playerId: player.id,
                gameId: gameId,
                propType: 'Caused Turnovers',
                line,
                overOdds: -105,
                underOdds: -115
            });
        }

        // Saves prop for goalies
        if (saves > 0) {
            const spg = saves / gp;
            const line = Math.max(8.5, Math.round(spg));

            props.push({
                playerId: player.id,
                gameId: gameId,
                propType: 'Saves',
                line: line,
                overOdds: -110,
                underOdds: -110
            });
        }

        if (turnovers > 0 && ['A', 'M'].includes(player.position)) {
            const topg = turnovers / gp;
            const line = Math.max(0.5, this.roundToHalf(topg));

            props.push({
                playerId: player.id,
                gameId: gameId,
                propType: 'Turnovers',
                line,
                overOdds: -118,
                underOdds: -102
            });
        }

        // Faceoff percentage prop for specialists
        if (faceoffPct > 0) {
            const pctLine = Math.round(faceoffPct * 200) / 2;

            props.push({
                playerId: player.id,
                gameId: gameId,
                propType: 'Faceoff %',
                line: pctLine,
                overOdds: -110,
                underOdds: -110
            });
        }

        return props;
    }

    async upsertOdds(client, gameId, odds) {
        const existing = await client.query(
            'SELECT id FROM odds WHERE game_id = $1 ORDER BY generated_at DESC NULLS LAST, id DESC LIMIT 1',
            [gameId]
        );

        if (existing.rows.length > 0) {
            await client.query(`
                UPDATE odds
                SET home_moneyline = $1,
                    away_moneyline = $2,
                    spread_line = $3,
                    spread_odds = $4,
                    total_line = $5,
                    over_odds = $6,
                    under_odds = $7,
                    home_win_prob = $8,
                    away_win_prob = $9,
                    generated_at = NOW()
                WHERE id = $10
            `, [
                odds.homeMoneyline,
                odds.awayMoneyline,
                odds.spreadLine,
                odds.spreadOdds,
                odds.totalLine,
                odds.overOdds,
                odds.underOdds,
                odds.homeWinProb,
                odds.awayWinProb,
                existing.rows[0].id
            ]);
            return;
        }

        await client.query(`
            INSERT INTO odds (
                game_id, home_moneyline, away_moneyline, spread_line, spread_odds,
                total_line, over_odds, under_odds, home_win_prob, away_win_prob
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [
            gameId,
            odds.homeMoneyline,
            odds.awayMoneyline,
            odds.spreadLine,
            odds.spreadOdds,
            odds.totalLine,
            odds.overOdds,
            odds.underOdds,
            odds.homeWinProb,
            odds.awayWinProb
        ]);
    }

    async upsertPlayerProp(client, prop) {
        const existing = await client.query(`
            SELECT id
            FROM player_props
            WHERE game_id = $1 AND player_id = $2 AND prop_type = $3
            ORDER BY generated_at DESC NULLS LAST, id DESC
            LIMIT 1
        `, [prop.gameId, prop.playerId, prop.propType]);

        if (existing.rows.length > 0) {
            await client.query(`
                UPDATE player_props
                SET line = $1,
                    over_odds = $2,
                    under_odds = $3,
                    generated_at = NOW()
                WHERE id = $4
            `, [prop.line, prop.overOdds, prop.underOdds, existing.rows[0].id]);
            return;
        }

        await client.query(`
            INSERT INTO player_props (game_id, player_id, prop_type, line, over_odds, under_odds)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [prop.gameId, prop.playerId, prop.propType, prop.line, prop.overOdds, prop.underOdds]);
    }

    /**
     * Generate and store odds for all upcoming games
     */
    async generateAllOdds() {
        const client = await pool.connect();

        try {
            // Get upcoming games
            const gamesResult = await client.query(`
                SELECT g.*, 
                       ht.name as home_name, ht.wins as home_wins, ht.losses as home_losses,
                       ht.goals_per_game as home_gpg, ht.goals_allowed_per_game as home_gapg,
                       ht.faceoff_pct as home_fo, ht.clear_pct as home_clear,
                       at.name as away_name, at.wins as away_wins, at.losses as away_losses,
                       at.goals_per_game as away_gpg, at.goals_allowed_per_game as away_gapg,
                       at.faceoff_pct as away_fo, at.clear_pct as away_clear
                FROM games g
                LEFT JOIN teams ht ON g.home_team_id = ht.id
                LEFT JOIN teams at ON g.away_team_id = at.id
                WHERE g.is_completed = false AND g.game_date >= CURRENT_DATE
            `);

            let generated = 0;

            for (const game of gamesResult.rows) {
                const homeTeam = {
                    wins: game.home_wins || 0,
                    losses: game.home_losses || 0,
                    goals_per_game: game.home_gpg || 7,
                    goals_allowed_per_game: game.home_gapg || 10,
                    faceoff_pct: game.home_fo || 0.5,
                    clear_pct: game.home_clear || 0.75
                };

                const awayTeam = {
                    wins: game.away_wins || 0,
                    losses: game.away_losses || 0,
                    goals_per_game: game.away_gpg || 9,
                    goals_allowed_per_game: game.away_gapg || 9,
                    faceoff_pct: game.away_fo || 0.5,
                    clear_pct: game.away_clear || 0.75
                };

                const odds = this.generateGameOdds(homeTeam, awayTeam);

                await this.upsertOdds(client, game.id, odds);

                generated++;
            }

            console.log(`📊 Generated odds for ${generated} games`);
            return generated;

        } finally {
            client.release();
        }
    }

    /**
     * Generate and store player props for all upcoming games.
     */
    async generateAllPlayerProps() {
        const client = await pool.connect();

        try {
            const gamesResult = await client.query(`
                SELECT id, home_team_id, away_team_id
                FROM games
                WHERE is_completed = false AND game_date >= CURRENT_DATE
            `);

            let generated = 0;

            for (const game of gamesResult.rows) {
                const teamIds = [game.home_team_id, game.away_team_id].filter(Boolean);
                if (teamIds.length === 0) {
                    continue;
                }

                const playersResult = await client.query(`
                    SELECT id, position, games_played, goals, assists, points, shots, shot_pct,
                           ground_balls, turnovers, caused_turnovers, saves, faceoff_pct
                    FROM players
                    WHERE team_id = ANY($1::int[])
                    ORDER BY points DESC, goals DESC, saves DESC, name ASC
                `, [teamIds]);

                for (const player of playersResult.rows) {
                    const props = this.generatePlayerProps(player, game.id);
                    for (const prop of props) {
                        await this.upsertPlayerProp(client, prop);
                        generated++;
                    }
                }
            }

            console.log(`🎯 Generated ${generated} player props`);
            return generated;
        } finally {
            client.release();
        }
    }
}

module.exports = new OddsEngine();
