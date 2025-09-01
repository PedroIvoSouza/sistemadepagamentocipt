// config/config.js
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const storage = process.env.SQLITE_STORAGE
  ? path.resolve(process.env.SQLITE_STORAGE)
  : path.resolve(__dirname, '../sistemacipt.db');

module.exports = {
  development: { dialect: 'sqlite', storage, logging: console.log },
  test:        { dialect: 'sqlite', storage, logging: false },
  production:  { dialect: 'sqlite', storage, logging: false },
};
