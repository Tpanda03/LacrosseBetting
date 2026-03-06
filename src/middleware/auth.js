const jwt = require('jsonwebtoken');
const pool = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

/**
 * Middleware to verify JWT token
 */
const authenticateToken = async (req, res, next) => {
    try {
        // Get token from header or cookie
        const authHeader = req.headers['authorization'];
        const token = authHeader?.split(' ')[1] || req.cookies?.token;

        if (!token) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Verify user still exists and is active
        const result = await pool.query(
            'SELECT id, email, username, role, is_active FROM users WHERE id = $1',
            [decoded.userId]
        );

        if (result.rows.length === 0 || !result.rows[0].is_active) {
            return res.status(401).json({ error: 'User not found or inactive' });
        }

        req.user = result.rows[0];
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired' });
        }
        return res.status(403).json({ error: 'Invalid token' });
    }
};

/**
 * Middleware to check admin role
 */
const requireAdmin = (req, res, next) => {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
};

/**
 * Optional auth - continues if no token, but populates user if present
 */
const optionalAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader?.split(' ')[1] || req.cookies?.token;

        if (token) {
            const decoded = jwt.verify(token, JWT_SECRET);
            const result = await pool.query(
                'SELECT id, email, username, role FROM users WHERE id = $1 AND is_active = true',
                [decoded.userId]
            );
            if (result.rows.length > 0) {
                req.user = result.rows[0];
            }
        }
    } catch (error) {
        // Token invalid or expired, continue without user
    }
    next();
};

/**
 * Generate JWT token
 */
const generateToken = (userId, email) => {
    return jwt.sign(
        { userId, email },
        JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
};

module.exports = {
    authenticateToken,
    requireAdmin,
    optionalAuth,
    generateToken
};
