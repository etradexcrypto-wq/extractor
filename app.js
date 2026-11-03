'use strict';

// cPanel Passenger looks for app.js by default. Keep the actual Express setup in server.js.
const app = require('./server');
const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  console.log(`Email Extractor listening on port ${port}`);
});
