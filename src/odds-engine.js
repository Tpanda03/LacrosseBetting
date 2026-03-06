const pool = require('../config/database');

class OddsEngine {
    /**
     * Calculate win probability using multiple factors
     */
    calculateWinProbability(team1, team2) {
        const t1GPG = team1.goals_per_game || (team1.goals / team1.games) || 7;
        const t1GAPG = team1.goals_allowed_per_game || (team1.goals_allowed / team1.games) || 10;
        const t2GPG = team2.goals_per_game || (team2.goals / team2.games) || 9;
        const t2GAPG = team2.goals_allowed_per_game || (team2.goals_allowed / team2.games) || 9;

        // Expected goals per team
        const t1Expected = (t1GPG + t2GAPG) / 2;
        const t2Expected = (t2GPG + t1GAPG) / 2;

        // Win percentage factor
        const t1WinPct = team1.wins / (team1.wins + team1.losses) || 0.5;
        const t2WinPct = team2.wins / (team2.wins + team2.losses) || 0.5;

        // Faceoff advantage
        const faceoffAdj1 = (parseFloat(team1.faceoff_pct) || 0.5) * 0.15;
        const faceoffAdj2 = (parseFloat(team2.faceoff_pct) || 0.5) * 0.15;

        // Combined power score
        const t1Score = (t1Expected * 0.35) + (t1WinPct * 0.35) + faceoffAdj1 + ((parseFloat(team1.clear_pct) || 0.75) * 0.15);
        const t2Score = (t2Expected * 0.35) + (t2WinPct * 0.35) + faceoffAdj2 + ((parseFloat(team2.clear_pct) || 0.75) * 0.15);

        return t1Score / (t1Score + t2Score);
    }

    /**
     * Convert probability to American odds
     */
    probabilityToAmerican(prob) {
        if (prob >= 0.5) {
            return Math.round(-100 * prob / (1 - prob));
        }
        return Math.round(100 * (1 - prob) / prob);
    }

    /**
     * Calculate point spread
     */
    calculateSpread(team1, team2) {
        const t1GPG = team1.goals_per_game || 7;
        const t2GPG = team2.goals_per_game || 9;
        const t1GAPG = team1.goals_allowed_per_game || 10;
        const t2GAPG = team2.goals_allowed_per_game || 9;

        const t1Expected = (t1GPG + t2GAPG) / 2;
        const t2Expected = (t2GPG + t1GAPG) / 2;

        return (t1Expected - t2Expected).toFixed(1);
    }

    /**
     * Calculate total (over/under) line
     */
    calculateTotal(team1, team2) {
        const t1GPG = team1.goals_per_game || 7;
        const t2GPG = team2.goals_per_game || 9;
        const t1GAPG = team1.goals_allowed_per_game || 10;
        const t2GAPG = team2.goals_allowed_per_game || 9;

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

        return {
            homeMoneyline: this.probabilityToAmerican(adjustedHomeProb),
            awayMoneyline: this.probabilityToAmerican(adjustedAwayProb),
            spreadLine: parseFloat(this.calculateSpread(homeTeam, awayTeam)),
            spreadOdds: -110,
            totalLine: parseFloat(this.calculateTotal(homeTeam, awayTeam)),
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
        const gp = player.games_played || 1;

        // Goals prop for attackers/midfielders
        if (player.goals > 0 || ['A', 'M'].includes(player.position)) {
            const gpg = player.goals / gp;
            const line = Math.max(0.5, Math.round(gpg * 2) / 2);
            const overProb = gpg > line ? 0.55 : 0.45;

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
        if (player.points > 0) {
            const ppg = player.points / gp;
            const line = Math.max(0.5, Math.round(ppg * 2) / 2);
            const overProb = ppg > line ? 0.55 : 0.45;

            props.push({
                playerId: player.id,
                gameId: gameId,
                propType: 'Points',
                line: line,
                overOdds: this.probabilityToAmerican(overProb),
                underOdds: this.probabilityToAmerican(1 - overProb)
            });
        }

        // Shots prop
        if (player.shots > 2) {
            const spg = player.shots / gp;
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

        // Saves prop for goalies
        if (player.saves > 0) {
            const spg = player.saves / gp;
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

        return props;
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

                // Upsert odds
                await client.query(`
                    INSERT INTO odds (game_id, home_moneyline, away_moneyline, spread_line, spread_odds,
                                     total_line, over_odds, under_odds, home_win_prob, away_win_prob)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                    ON CONFLICT (game_id) DO UPDATE SET
                        home_moneyline = EXCLUDED.home_moneyline,
                        away_moneyline = EXCLUDED.away_moneyline,
                        spread_line = EXCLUDED.spread_line,
                        total_line = EXCLUDED.total_line,
                        home_win_prob = EXCLUDED.home_win_prob,
                        away_win_prob = EXCLUDED.away_win_prob,
                        generated_at = NOW()
                `, [
                    game.id, odds.homeMoneyline, odds.awayMoneyline, odds.spreadLine,
                    odds.spreadOdds, odds.totalLine, odds.overOdds, odds.underOdds,
                    odds.homeWinProb, odds.awayWinProb
                ]);

                generated++;
            }

            console.log(`📊 Generated odds for ${generated} games`);
            return generated;

        } finally {
            client.release();
        }
    }
}

module.exports = new OddsEngine();
