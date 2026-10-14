const express = require('express');
const router = express.Router();
const { list, mine, getOne, search, create, remove } = require('../controllers/thingController');
const { authenticate, requireRole } = require('../middleware/auth');

router.get('/', list);
router.use(authenticate);
router.get('/mine', mine);
router.get('/search', search);
router.get('/:id', getOne);
router.post('/', requireRole('admin'), create);
router.delete('/:id', remove);

module.exports = router;
