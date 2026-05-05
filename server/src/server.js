import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path: path.resolve(__dirname, '../.env'),
});

const { default: app } = await import('./app.js');

const PORT = Number(process.env.PORT) || 8060;

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
