import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), 'server/.env') });

export const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(403).json({ message: 'No token provided' });

  const token = authHeader.split(' ')[1];
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ message: 'Unauthorized' });
    req.user = decoded;
    next();
  });
};

export const verifyRole = (...roles) => (req, res, next) => {
  const userRole = req.user?.role;
  if (!userRole || !roles.includes(userRole)) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  next();
};

export const auditLogger = (req, res, next) => {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl,
      username: req.user?.username || 'anonymous',
      role: req.user?.role || 'none',
      ip: req.ip,
      ua: req.headers['user-agent'] || ''
    }) + '\n';
    const logFile = path.join(process.cwd(), 'server', 'logs', 'audit.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, line);
  } catch {}
  next();
};
