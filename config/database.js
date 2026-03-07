const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;

const resolveSslConfig = () => {
    const explicitSsl = process.env.DB_SSL;
    if (typeof explicitSsl === 'string') {
        const normalized = explicitSsl.toLowerCase();
        if (['1', 'true', 'yes', 'require'].includes(normalized)) {
            return {
                rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false'
            };
        }
        return false;
    }

    if (!connectionString) {
        return false;
    }

    try {
        const hostname = new URL(connectionString).hostname;
        if (['localhost', '127.0.0.1', '::1', 'db'].includes(hostname)) {
            return false;
        }
    } catch (error) {
        return false;
    }

    return process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false;
};

const pool = new Pool({
    connectionString,
    ssl: resolveSslConfig()
});

pool.on('connect', () => {
    console.log('📦 Connected to PostgreSQL database');
});

pool.on('error', (err) => {
    console.error('❌ Database connection error:', err);
});

module.exports = pool;
