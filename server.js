'use strict';

// Keep `node server.js` and existing imports compatible with the src/ layout.
const server = require('./src/server');
module.exports = server;

if (require.main === module) {
    server.startServer().catch(error => {
        console.error(`Error iniciando servidor: ${error.message}`);
        process.exitCode = 1;
    });
}
