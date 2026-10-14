const pool = require('../config/db');

const THING_SELECT = `
  SELECT t.id, t.name, o.name AS owner_name
  FROM things t
  JOIN owners o ON o.id = t.owner_id`;

async function listThings(where, params = []) {
  const result = await pool.query(`${THING_SELECT} WHERE ${where} ORDER BY t.name`, params);
  return result.rows;
}

async function findThing(id) {
  const result = await pool.query(
    `WITH recent AS (SELECT * FROM things WHERE created_at > NOW() - INTERVAL '1 day')
     SELECT * FROM recent WHERE id = $1`,
    [id],
  );
  return result.rows[0];
}

async function countSince(q) {
  const result = await pool.query(
    'SELECT EXTRACT(EPOCH FROM created_at) AS ts FROM things WHERE name ILIKE $1',
    [`%${q}%`],
  );
  return result.rows;
}

async function insertThing(db, ownerId, fields) {
  const result = await db.query(
    `INSERT INTO things (name, owner_id) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [fields.name, ownerId],
  );
  return result.rows[0];
}

async function renameThing(db, id, fields) {
  const sets = Object.keys(fields).map((k, i) => `${k} = $${i + 2}`);
  await db.query(`UPDATE things SET ${sets.join(', ')} WHERE id = $1`, [id, ...Object.values(fields)]);
}

async function deleteThing(id) {
  await pool.query('DELETE FROM things WHERE id = $1', [id]);
}

async function logAudit(table, id) {
  await pool.query(`INSERT INTO ${table} (thing_id) VALUES ($1)`, [id]);
}

module.exports = { listThings, findThing, countSince, insertThing, renameThing, deleteThing, logAudit };
