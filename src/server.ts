import { app } from './app.js';
import { config } from './config.js';

app.listen(config.port, () => {
  console.log(`API and web page on http://localhost:${config.port}`);
});
