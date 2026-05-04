import app from './app.js';
import dotenv from 'dotenv';
dotenv.config();

const PORT = Number(process.env.PORT) || 8070;

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
