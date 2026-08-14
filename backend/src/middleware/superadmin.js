const jwt = require('jsonwebtoken');

const superAdminMiddleware = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check if user has superadmin role
    if (decoded.role !== 'superadmin') {
      return res.status(403).json({ error: 'Access denied. SuperAdmin privileges required.' });
    }
    
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

module.exports = superAdminMiddleware;
