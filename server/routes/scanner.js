'use strict';

const express = require('express');
const router  = express.Router();
const scanner = require('../services/scannerService');

router.get('/results',  (req, res) => res.json(scanner.getHistory()));
router.get('/settings', (req, res) => res.json(scanner.getSettings()));

router.patch('/settings', async (req, res) => {
  try   { res.json(await scanner.applySettings(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/scan', async (req, res) => {
  try {
    const found = await scanner.runScan();
    res.json({ found: found.length, networks: found });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/history', (req, res) => {
  scanner.clearHistory();
  res.json({ ok: true });
});

module.exports = router;
