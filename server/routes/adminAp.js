'use strict';

const express = require('express');
const router = express.Router();
const adminApService = require('../services/adminApService');

// GET /api/admin-ap — current settings (password omitted)
router.get('/', async (req, res) => {
  try {
    const settings = adminApService.getSettings();
    const running = adminApService.isRunning();
    res.json({ ...settings, running });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin-ap — update ssid / password / channel
router.patch('/', async (req, res) => {
  try {
    const settings = await adminApService.applySettings(req.body);
    res.json(settings);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/admin-ap/start
router.post('/start', async (req, res) => {
  try {
    const { stdout, stderr } = await adminApService.start();
    res.json({ ok: true, stdout, stderr });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin-ap/stop
router.post('/stop', async (req, res) => {
  try {
    const { stdout, stderr } = await adminApService.stop();
    res.json({ ok: true, stdout, stderr });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
