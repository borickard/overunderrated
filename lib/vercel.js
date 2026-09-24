'use strict';

// Shared by every file in /api so one warm instance reuses one store.
const { createHandler } = require('./api');

module.exports = createHandler();
