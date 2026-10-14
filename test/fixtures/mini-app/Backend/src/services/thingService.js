const { withTransaction } = require('../config/db');
const Thing = require('../models/thingModel');

function parseThing(body) {
  if (!body.name) throw new Error('name is required');
  return { name: String(body.name) };
}

async function createThing(user, body) {
  const fields = parseThing(body);
  return withTransaction(async (db) => {
    const thing = await Thing.insertThing(db, user.id, fields);
    await Thing.renameThing(db, thing.id, { name: fields.name });
    return thing;
  });
}

module.exports = { createThing };
