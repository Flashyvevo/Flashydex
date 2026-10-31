const Database = require("better-sqlite3");

const database = new Database(":memory:");
database.exec("CREATE TABLE smoke (id INTEGER PRIMARY KEY)");
database.close();
console.log(`better-sqlite3 loads on Node ${process.version}`);
