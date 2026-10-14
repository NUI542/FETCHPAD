const Thing = require('../models/thingModel');
const thingService = require('../services/thingService');

async function list(req, res) {
  res.json(await Thing.listThings('TRUE'));
}

async function mine(req, res) {
  res.json(await Thing.listThings('t.owner_id = $1', [req.user.id]));
}

async function getOne(req, res) {
  res.json(await Thing.findThing(req.params.id));
}

async function search(req, res) {
  res.json(await Thing.countSince(req.query.q));
}

async function create(req, res) {
  res.status(201).json(await thingService.createThing(req.user, req.body));
}

async function remove(req, res) {
  await Thing.deleteThing(req.params.id);
  res.status(204).end();
}

module.exports = { list, mine, getOne, search, create, remove };
