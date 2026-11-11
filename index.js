// -----------------------------------------------------------------------------
// Entry point: SDK wiring only. Every handler is registered BEFORE connect(),
// and delegates to the ForestApp (src/app.js). Read only: no command handler,
// nothing is ever commanded.
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { ForestApp } from './src/app.js';
import { ACTIONS } from './src/constants.js';

const gladys = new GladysIntegration();
const app = new ForestApp({ gladys });

// --- Discovery: the departments of the configuration, never a read of the source ---
gladys.onScanRequest(() => app.scan());
gladys.onDeviceCreated((device) => app.deviceChanged(device));
gladys.onDeviceUpdated((device) => app.deviceChanged(device));
gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

// --- Configuration screen button ---------------------------------------------------
gladys.onAction(ACTIONS.TEST, () => app.testConnection());

// --- Configuration changed by the user ----------------------------------------
gladys.onConfigUpdated((config) => {
  logger.info('Configuration updated: restarting');
  return app.start(config);
});

// --- Connection lifecycle ------------------------------------------------------
// Every connection (the first one and each reconnection): the configuration
// (getConfig retried without end), then Discovery, the status and the reads.
gladys.on('connected', () => {
  app
    .connected(() => gladys.getConfig())
    .catch((err) => {
      logger.error(`Start failed (${err?.name ?? 'Error'})`);
    });
});
gladys.on('disconnected', () => {
  app.stop().catch((err) => logger.error(`Stop failed (${err?.name ?? 'Error'})`));
});
gladys.handleShutdown(() => app.stop());

// --- Startup ---------------------------------------------------------------------
logger.info('Starting the Météo des forêts integration');
gladys.connect().catch((err) => {
  logger.error(`Initial connection failed (${err?.name ?? 'Error'})`);
  process.exit(1);
});
