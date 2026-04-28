'use strict';

const express = require('express');
const router = express.Router();
const logService = require('../services/logService');

router.get('/', async (req, res) => {
  try {
    const lines = parseInt(req.query.lines, 10) || 100;
    const logs = await logService.getLogs({ lines });
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
