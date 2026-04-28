'use strict';

const express = require('express');
const router = express.Router();
const interfaceService = require('../services/interfaceService');
const networkManager = require('../services/networkManager');

router.get('/', async (req, res) => {
  try {
    const [ifaces, networkState] = await Promise.all([
      interfaceService.listWifiInterfaces(),
      networkManager.getSystemStatus(),
    ]);

    // Annotate each interface with how many profiles are running on it
    const activeLookup = {};
    for (const phyStatus of Object.values(networkState)) {
      for (const p of phyStatus.profiles) {
        activeLookup[p.logicalIface] = true;
      }
    }

    const annotated = ifaces.map(i => ({
      ...i,
      inUse: !!activeLookup[i.name],
    }));

    res.json(annotated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
