import cors from 'cors';
import 'dotenv/config';
import express from 'express';
import routes from './routes/index.js';
import { logger } from './shared.js';
import { init } from './wa.js';

const app = express();
app.use(cors());
app.use(express.json());
// Log de requisições via pino (assíncrono) em vez de console.log (I/O
// síncrono a cada request — pesa mais com o polling de status do frontend).
app.use((req, _res, next) => {
  logger.debug({ method: req.method, path: req.path }, 'REQ');
  next();
});
app.use('/', routes);
app.all('*', (req, res) => res.status(404).json({ error: 'URL not found' }));

const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3000);
const listener = () => console.log(`Server is listening on http://${host}:${port}`);

(async () => {
  await init();
  app.listen(port, host, listener);
})();
