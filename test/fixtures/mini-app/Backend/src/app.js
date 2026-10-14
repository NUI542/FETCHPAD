const express = require('express');
const thingRoutes = require('./routes/thingRoutes');

const app = express();
app.use(express.json());

app.get('/', (req, res) => res.json({ ok: true }));
app.use('/api/things', thingRoutes);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

module.exports = app;
