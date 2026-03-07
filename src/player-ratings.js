class PlayerRatings {
    toNumber(value, fallback = 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    normalizeShotPct(shotPct) {
        const value = this.toNumber(shotPct, 0);
        if (value > 1) {
            return Math.max(0, Math.min(1, value / 100));
        }
        return Math.max(0, Math.min(1, value));
    }

    estimateShotsOnGoal(player) {
        const explicit = this.toNumber(player.shots_on_goal, null);
        if (explicit !== null) {
            return explicit;
        }

        const shots = this.toNumber(player.shots, 0);
        const shotPct = this.normalizeShotPct(player.shot_pct);
        if (shotPct > 0) {
            return shots * shotPct;
        }

        return shots * 0.55;
    }

    resolveRole(position) {
        const normalized = String(position || '').trim().toUpperCase();

        if (normalized.startsWith('A')) {
            return 'attack';
        }

        if (normalized.startsWith('M')) {
            return 'midfielder';
        }

        if (normalized.startsWith('G')) {
            return 'goalie';
        }

        return 'defense';
    }

    buildStatProfile(player) {
        return {
            goals: this.toNumber(player.goals, 0),
            assists: this.toNumber(player.assists, 0),
            groundBalls: this.toNumber(player.ground_balls, 0),
            turnovers: this.toNumber(player.turnovers, 0),
            causedTurnovers: this.toNumber(player.caused_turnovers, 0),
            shotsOnGoal: this.estimateShotsOnGoal(player)
        };
    }

    calculateAttackRating(stats) {
        return (3 * stats.goals)
            + (2 * stats.assists)
            + (0.5 * stats.groundBalls)
            - (0.5 * stats.turnovers)
            + (0.3 * stats.shotsOnGoal);
    }

    calculateMidfielderRating(stats) {
        return (2 * stats.goals)
            + (2 * stats.assists)
            + (1.5 * stats.groundBalls)
            + (1.5 * stats.causedTurnovers)
            + (0.5 * stats.shotsOnGoal)
            - (0.5 * stats.turnovers);
    }

    calculateDefenseRating(stats) {
        return (2 * stats.causedTurnovers)
            + (2 * stats.groundBalls)
            + (0.5 * stats.goals)
            + (0.5 * stats.assists)
            - (0.5 * stats.turnovers);
    }

    calculate(player) {
        const role = this.resolveRole(player.position);
        const stats = this.buildStatProfile(player);

        if (role === 'attack') {
            return Number(this.calculateAttackRating(stats).toFixed(2));
        }

        if (role === 'midfielder') {
            return Number(this.calculateMidfielderRating(stats).toFixed(2));
        }

        if (role === 'goalie') {
            return Number(this.calculateDefenseRating(stats).toFixed(2));
        }

        return Number(this.calculateDefenseRating(stats).toFixed(2));
    }

    calculateWithBreakdown(player) {
        const role = this.resolveRole(player.position);
        const stats = this.buildStatProfile(player);
        const rating = this.calculate(player);

        return {
            role,
            rating,
            stats
        };
    }
}

module.exports = new PlayerRatings();
