const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query } = require('../../config/db');
const email = require('../../services/email.service');
const storage = require('../../services/storage.service');

const generateTokens = (userId, role) => {
  const accessToken = jwt.sign(
    { userId, role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_ACCESS_EXPIRES || '15m' }
  );
  const refreshToken = crypto.randomBytes(40).toString('hex');
  return { accessToken, refreshToken };
};

// POST /api/auth/register
const register = async (req, res, next) => {
  try {
    const { firstName, lastName, email, phone, password, dateOfBirth } = req.body;

    const passwordHash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS) || 12);

    const result = await query(
      `INSERT INTO users (first_name, last_name, email, phone, password_hash, date_of_birth)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, first_name, last_name, email, phone, role, status, created_at`,
      [firstName, lastName, email.toLowerCase(), phone, passwordHash, dateOfBirth || null]
    );

    const user = result.rows[0];

    if (req.file) {
      const url = await storage.uploadFile(
        `profiles/${user.id}/avatar`,
        req.file.buffer,
        req.file.mimetype
      );
      await query('UPDATE users SET profile_photo_url = $1 WHERE id = $2', [url, user.id]);
      user.profile_photo_url = url;
    }

    const { accessToken, refreshToken } = generateTokens(user.id, user.role);

    // Store hashed refresh token
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, tokenHash, expiresAt]
    );

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      data: { user, accessToken, refreshToken },
    });
    email.sendWelcome(user);
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/login
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const result = await query(
      `SELECT id, first_name, last_name, email, phone, password_hash, role, status
       FROM users WHERE email = $1`,
      [email.toLowerCase()]
    );

    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    if (user.status === 'suspended' || user.status === 'banned') {
      return res.status(403).json({ success: false, message: `Account ${user.status}` });
    }

    const { accessToken, refreshToken } = generateTokens(user.id, user.role);
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, tokenHash, expiresAt]
    );
    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    const { password_hash, ...safeUser } = user;
    res.json({
      success: true,
      data: { user: safeUser, accessToken, refreshToken },
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/refresh
const refreshToken = async (req, res, next) => {
  try {
    const { refreshToken: token } = req.body;
    if (!token) return res.status(400).json({ success: false, message: 'Refresh token required' });

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await query(
      `SELECT rt.*, u.id AS user_id, u.role, u.status
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1 AND rt.revoked = FALSE AND rt.expires_at > NOW()`,
      [tokenHash]
    );

    if (!result.rows.length) {
      return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
    }

    const stored = result.rows[0];
    if (stored.status === 'suspended' || stored.status === 'banned') {
      return res.status(403).json({ success: false, message: 'Account disabled' });
    }

    // Rotate token
    await query('UPDATE refresh_tokens SET revoked = TRUE WHERE id = $1', [stored.id]);
    const { accessToken, refreshToken: newRefresh } = generateTokens(stored.user_id, stored.role);
    const newHash = crypto.createHash('sha256').update(newRefresh).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [stored.user_id, newHash, expiresAt]
    );

    res.json({ success: true, data: { accessToken, refreshToken: newRefresh } });
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/logout
const logout = async (req, res, next) => {
  try {
    const { refreshToken: token } = req.body;
    if (token) {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await query('UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1', [tokenHash]);
    }
    res.json({ success: true, message: 'Logged out' });
  } catch (err) {
    next(err);
  }
};

// GET /api/auth/me
const getMe = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, first_name, last_name, email, phone, role, status,
              date_of_birth, id_type, id_verified, profile_photo_url, last_login_at, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/auth/me
const updateProfile = async (req, res, next) => {
  try {
    const { firstName, lastName, phone } = req.body;

    let photoUrl;
    if (req.file) {
      photoUrl = await storage.uploadFile(
        `profiles/${req.user.id}/avatar`,
        req.file.buffer,
        req.file.mimetype
      );
    }

    const result = await query(
      `UPDATE users
         SET first_name         = COALESCE($1, first_name),
             last_name          = COALESCE($2, last_name),
             phone              = COALESCE($3, phone),
             profile_photo_url  = COALESCE($4, profile_photo_url),
             updated_at         = NOW()
       WHERE id = $5
       RETURNING id, first_name, last_name, email, phone, profile_photo_url`,
      [firstName || null, lastName || null, phone || null, photoUrl || null, req.user.id]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/change-password
const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const result = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!(await bcrypt.compare(currentPassword, result.rows[0].password_hash))) {
      return res.status(400).json({ success: false, message: 'Current password incorrect' });
    }
    const newHash = await bcrypt.hash(newPassword, parseInt(process.env.BCRYPT_ROUNDS) || 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.id]);
    // Revoke all refresh tokens
    await query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1', [req.user.id]);
    res.json({ success: true, message: 'Password updated. Please log in again.' });
    email.sendPasswordChanged(req.user);
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/forgot-password
const forgotPassword = async (req, res, next) => {
  try {
    const { email: emailAddr } = req.body;

    const result = await query(
      `SELECT id, first_name, last_name, email FROM users
       WHERE email = $1 AND status NOT IN ('banned')`,
      [emailAddr.toLowerCase()]
    );
    const user = result.rows[0];

    if (user) {
      // Invalidate any existing unused tokens for this user
      await query(
        `UPDATE password_resets SET used_at = NOW()
         WHERE user_id = $1 AND used_at IS NULL`,
        [user.id]
      );

      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await query(
        'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
        [user.id, tokenHash, expiresAt]
      );

      email.sendPasswordReset(user, token);
    }

    // Always return 200 — never reveal whether the email exists
    res.json({ success: true, message: 'If that email is registered, a reset link has been sent.' });
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/reset-password/:token
const resetPassword = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await query(
      `SELECT pr.id, pr.user_id
       FROM password_resets pr
       WHERE pr.token_hash = $1
         AND pr.used_at IS NULL
         AND pr.expires_at > NOW()`,
      [tokenHash]
    );

    if (!result.rows.length) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset link.' });
    }

    const { id: resetId, user_id: userId } = result.rows[0];

    const passwordHash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS) || 12);
    await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [passwordHash, userId]);
    await query('UPDATE password_resets SET used_at = NOW() WHERE id = $1', [resetId]);
    await query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1', [userId]);

    res.json({ success: true, message: 'Password reset successfully. Please log in.' });
  } catch (err) {
    next(err);
  }
};

module.exports = { register, login, refreshToken, logout, getMe, updateProfile, changePassword, forgotPassword, resetPassword };
