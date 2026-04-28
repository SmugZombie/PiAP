'use strict';

const express = require('express');
const router = express.Router();
const dhcpService = require('../services/dhcpService');
const profileService = require('../services/profileService');
const networkManager = require('../services/networkManager');

router.get('/', async (req, res) => {
  try {
    const [leases, systemStatus, activeProfiles] = await Promise.all([
      Promise.resolve(dhcpService.parseLeases()),
      networkManager.getSystemStatus(),
      Promise.resolve(profileService.getActiveProfiles()),
    ]);

    // Match each lease to a profile by checking if the client IP falls in its subnet
    const { matchLeaseToProfile } = dhcpService;
    const annotatedLeases = leases.map(lease => ({
      ...lease,
      profileId: matchLeaseToProfile(lease.ip, activeProfiles),
    }));

    res.json({
      activeProfiles: activeProfiles.map(p => ({ id: p.id, ssid: p.ssid, interface: p.interface })),
      systemStatus,
      clients: annotatedLeases,
      count: annotatedLeases.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
