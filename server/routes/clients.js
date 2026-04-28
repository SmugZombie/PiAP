'use strict';

const express = require('express');
const router = express.Router();
const dhcpService = require('../services/dhcpService');
const profileService = require('../services/profileService');
const networkService = require('../services/networkService');

router.get('/', async (req, res) => {
  try {
    const leases = dhcpService.parseLeases();
    const active = profileService.getActiveProfile();
    const systemStatus = await networkService.getSystemStatus();

    res.json({
      activeProfile: active ? { id: active.id, ssid: active.ssid } : null,
      systemStatus,
      clients: leases,
      count: leases.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
